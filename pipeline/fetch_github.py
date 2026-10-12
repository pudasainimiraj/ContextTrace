#!/usr/bin/env python3
"""Fetch a GitHub issue or discussion and all of its comments into a local JSON file.

Usage:
    python fetch_github.py --passages Contexttrace_dagster_20_Passages.json --number 4194
    python fetch_github.py --repo dagster-io/dagster --number 2219
    python fetch_github.py --repo dagster-io/dagster --type discussion --number 21343

With ``--passages`` the repository and the document type come from the
passages file. With ``--repo`` any issue or discussion can be fetched.
Issues use the REST API. Discussions use the GraphQL API, which needs a
token; replies are flattened into the comment list with ``reply_to`` set.
The token comes from GITHUB_TOKEN, GH_TOKEN, or ``gh auth token``. Without
a token the REST limit is 60 requests per hour.
"""

from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_ROOT = "https://api.github.com"
GRAPHQL_URL = f"{API_ROOT}/graphql"
API_VERSION = "2022-11-28"
USER_AGENT = "contexttrace-fetcher"
PER_PAGE = 100
MAX_ATTEMPTS = 5
REQUEST_TIMEOUT = 30
SECONDARY_LIMIT_BASE_WAIT = 60

log = logging.getLogger("fetch_github")


class FetchError(Exception):
    """A request failed in a way that a retry will not fix."""


def find_token() -> str | None:
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value:
            log.info("Using token from %s", name)
            return value
    try:
        result = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, timeout=10, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    token = result.stdout.strip()
    if result.returncode == 0 and token:
        log.info("Using token from `gh auth token`")
        return token
    return None


def parse_next_link(link_header: str | None) -> str | None:
    """Return the URL with rel="next" from a Link header, or None."""
    if not link_header:
        return None
    match = re.search(r'<([^>]+)>[^,]*rel="next"', link_header)
    return match.group(1) if match else None


def _backoff(attempt: int) -> float:
    return float(2 ** (attempt - 1))


def _error_message(body: bytes) -> str:
    try:
        return str(json.loads(body).get("message", ""))
    except (ValueError, AttributeError):
        return body.decode("utf-8", errors="replace")[:200]


class GitHubClient:
    def __init__(self, token: str | None, sleep=time.sleep):
        self.token = token
        self._sleep = sleep

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": USER_AGENT,
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def get_json(self, url: str):
        return self.request_json(url)

    def request_json(self, url: str, payload: dict | None = None):
        """GET ``url``, or POST ``payload`` as JSON, and return ``(parsed_json, headers)``.

        Retries server errors, network errors, and rate limits. Raises
        FetchError for other HTTP errors or when every attempt fails.
        """
        headers = self._headers()
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        last_error: Exception | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            request = urllib.request.Request(url, data=data, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                    headers = response.headers
                    body = response.read()
                return json.loads(body), headers
            except urllib.error.HTTPError as err:
                message = _error_message(err.read())
                if err.code in (403, 429):
                    wait = self._rate_limit_wait(err, message, attempt)
                    if wait is None:
                        raise FetchError(f"HTTP {err.code} for {url}: {message}") from err
                    log.warning(
                        "Rate limited (HTTP %d: %s) (attempt %d/%d)",
                        err.code, message, attempt, MAX_ATTEMPTS,
                    )
                elif err.code >= 500:
                    wait = _backoff(attempt)
                    log.warning(
                        "HTTP %d for %s (attempt %d/%d)", err.code, url, attempt, MAX_ATTEMPTS
                    )
                else:
                    raise FetchError(f"HTTP {err.code} for {url}: {message}") from err
                last_error = err
            except (
                urllib.error.URLError,
                http.client.HTTPException,
                ConnectionError,
                TimeoutError,
                json.JSONDecodeError,
            ) as err:
                wait = _backoff(attempt)
                log.warning(
                    "Request to %s failed: %s (attempt %d/%d)", url, err, attempt, MAX_ATTEMPTS
                )
                last_error = err
            if attempt < MAX_ATTEMPTS:
                log.info("Retrying in %.0fs", wait)
                self._sleep(wait)
        raise FetchError(f"Giving up on {url} after {MAX_ATTEMPTS} attempts: {last_error}")

    @staticmethod
    def _rate_limit_wait(err: urllib.error.HTTPError, message: str, attempt: int) -> float | None:
        """Seconds to wait for a 403/429 response, or None if it is not a rate limit."""
        headers = err.headers
        retry_after = headers.get("Retry-After", "")
        if retry_after.isdigit():
            return float(retry_after)
        if headers.get("X-RateLimit-Remaining") == "0":
            return GitHubClient._seconds_until_reset(headers)
        if err.code == 429 or "rate limit" in message.lower():
            # Secondary limit without Retry-After: wait at least one minute.
            return float(SECONDARY_LIMIT_BASE_WAIT * 2 ** (attempt - 1))
        return None

    @staticmethod
    def _seconds_until_reset(headers) -> float:
        reset = headers.get("X-RateLimit-Reset", "")
        if reset.isdigit():
            return max(0.0, int(reset) - time.time()) + 1
        return float(SECONDARY_LIMIT_BASE_WAIT)

    def graphql(self, query: str, variables: dict) -> dict:
        """POST a GraphQL query and return its ``data``. The GraphQL API needs a token."""
        if not self.token:
            raise FetchError("The GraphQL API needs a token; set GITHUB_TOKEN or run `gh auth login`")
        for attempt in range(1, MAX_ATTEMPTS + 1):
            body, headers = self.request_json(GRAPHQL_URL, {"query": query, "variables": variables})
            errors = body.get("errors") or []
            if not errors:
                return body["data"]
            if attempt < MAX_ATTEMPTS and any(e.get("type") == "RATE_LIMITED" for e in errors):
                wait = self._seconds_until_reset(headers)
                log.warning("GraphQL rate limited (attempt %d/%d). Retrying in %.0fs", attempt, MAX_ATTEMPTS, wait)
                self._sleep(wait)
                continue
            raise FetchError("GraphQL error: " + "; ".join(str(e.get("message")) for e in errors))
        raise FetchError("GraphQL rate limit did not clear")

    def get_all_pages(self, url: str) -> list:
        """GET every page of a list endpoint by following Link rel="next"."""
        items: list = []
        page = 1
        next_url: str | None = url
        while next_url:
            data, headers = self.get_json(next_url)
            if not isinstance(data, list):
                raise FetchError(f"Expected a JSON list from {next_url}")
            items.extend(data)
            log.info("Fetched page %d (%d items)", page, len(data))
            next_url = parse_next_link(headers.get("Link"))
            page += 1
        return items


def fetch_issue(client: GitHubClient, repository: str, number: int) -> dict:
    data, _ = client.get_json(f"{API_ROOT}/repos/{repository}/issues/{number}")
    return data


def fetch_issue_comments(
    client: GitHubClient, repository: str, number: int, per_page: int = PER_PAGE
) -> list:
    url = f"{API_ROOT}/repos/{repository}/issues/{number}/comments?per_page={per_page}"
    return client.get_all_pages(url)


def _login(user: dict | None) -> str | None:
    return user.get("login") if user else None


def normalize_issue(raw: dict) -> dict:
    return {
        "number": raw["number"],
        "title": raw["title"],
        "state": raw["state"],
        "author": _login(raw.get("user")),
        "author_association": raw.get("author_association"),
        "created_at": raw["created_at"],
        "updated_at": raw.get("updated_at"),
        "closed_at": raw.get("closed_at"),
        "labels": [label["name"] for label in raw.get("labels", [])],
        "html_url": raw["html_url"],
        "body": raw.get("body") or "",
        "comments_count": raw.get("comments", 0),
    }


def normalize_comment(raw: dict) -> dict:
    return {
        "id": raw["id"],
        "author": _login(raw.get("user")),
        "author_association": raw.get("author_association"),
        "created_at": raw["created_at"],
        "updated_at": raw.get("updated_at"),
        "html_url": raw["html_url"],
        "body": raw.get("body") or "",
    }


_COMMENT_FIELDS = """
fragment CommentFields on DiscussionComment {
  id databaseId url body createdAt updatedAt isAnswer authorAssociation author { login }
}"""

DISCUSSION_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      number title url body createdAt updatedAt authorAssociation
      author { login }
      category { name }
      answer { databaseId }
      comments(first: 100, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          ...CommentFields
          replies(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { ...CommentFields }
          }
        }
      }
    }
  }
}""" + _COMMENT_FIELDS

REPLIES_QUERY = """
query($id: ID!, $after: String) {
  node(id: $id) {
    ... on DiscussionComment {
      replies(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ...CommentFields }
      }
    }
  }
}""" + _COMMENT_FIELDS


def fetch_discussion(client: GitHubClient, repository: str, number: int) -> tuple[dict, list[dict]]:
    """Return ``(discussion, comments)``; comments holds every top-level comment and reply."""
    owner, name = repository.split("/", 1)
    variables: dict = {"owner": owner, "name": name, "number": number, "after": None}
    comments: list[dict] = []
    page = 1
    while True:
        data = client.graphql(DISCUSSION_QUERY, variables)
        node = data["repository"]["discussion"]
        if node is None:
            raise FetchError(f"Discussion #{number} not found in {repository}")
        connection = node["comments"]
        for comment in connection["nodes"]:
            comments.append(normalize_discussion_comment(comment, reply_to=None))
            replies = comment["replies"]["nodes"]
            if comment["replies"]["pageInfo"]["hasNextPage"]:
                replies = replies + _fetch_more_replies(
                    client, comment["id"], comment["replies"]["pageInfo"]["endCursor"]
                )
            comments.extend(
                normalize_discussion_comment(reply, reply_to=comment["databaseId"]) for reply in replies
            )
        log.info("Fetched page %d (%d comments)", page, len(connection["nodes"]))
        if not connection["pageInfo"]["hasNextPage"]:
            return normalize_discussion(node), comments
        variables["after"] = connection["pageInfo"]["endCursor"]
        page += 1


def _fetch_more_replies(client: GitHubClient, comment_node_id: str, cursor: str | None) -> list:
    replies: list = []
    while cursor:
        data = client.graphql(REPLIES_QUERY, {"id": comment_node_id, "after": cursor})
        connection = data["node"]["replies"]
        replies.extend(connection["nodes"])
        page_info = connection["pageInfo"]
        cursor = page_info["endCursor"] if page_info["hasNextPage"] else None
    return replies


def normalize_discussion(raw: dict) -> dict:
    return {
        "number": raw["number"],
        "title": raw["title"],
        "category": (raw.get("category") or {}).get("name"),
        "author": _login(raw.get("author")),
        "author_association": raw.get("authorAssociation"),
        "created_at": raw["createdAt"],
        "updated_at": raw.get("updatedAt"),
        "html_url": raw["url"],
        "body": raw.get("body") or "",
        "comments_count": raw["comments"]["totalCount"],
        "answer_comment_id": (raw.get("answer") or {}).get("databaseId"),
    }


def normalize_discussion_comment(raw: dict, reply_to: int | None) -> dict:
    return {
        "id": raw["databaseId"],
        "author": _login(raw.get("author")),
        "author_association": raw.get("authorAssociation"),
        "created_at": raw["createdAt"],
        "updated_at": raw.get("updatedAt"),
        "html_url": raw["url"],
        "body": raw.get("body") or "",
        "is_answer": bool(raw.get("isAnswer")),
        "reply_to": reply_to,
    }


def load_document(passages_path: Path, number: int) -> tuple[str, dict]:
    with open(passages_path, encoding="utf-8") as fh:
        passages = json.load(fh)
    for doc in passages["documents"]:
        if doc["number"] == number:
            return passages["repository"], doc
    raise SystemExit(f"Document #{number} not found in {passages_path}")


def write_json_atomic(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fetch a GitHub issue and all of its comments into a local JSON file."
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--passages", type=Path, help="passages JSON file; the repository comes from it")
    source.add_argument("--repo", help="owner/name; fetch a document that is not in the passages file")
    parser.add_argument("--number", required=True, type=int, help="issue or discussion number")
    parser.add_argument("--type", choices=("issue", "discussion"), default="issue",
                        help="document type when using --repo (default: issue)")
    parser.add_argument("--per-page", type=int, default=PER_PAGE, help="issue comments per API page (max 100)")
    parser.add_argument("--out-dir", type=Path, default=Path("data/github"))
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr
    )

    if args.passages:
        repository, doc = load_document(args.passages, args.number)
        doc_type = doc["type"]
        document_id = doc["document_id"]
    else:
        repository = args.repo
        doc_type = args.type
        document_id = f"github:{repository}:{doc_type}:{args.number}"
    if doc_type not in ("issue", "discussion"):
        raise SystemExit(
            f"Document #{args.number} has type {doc_type!r}; only 'issue' and 'discussion' are supported"
        )

    client = GitHubClient(find_token())
    if client.token is None:
        log.warning("No GitHub token found; the unauthenticated limit is 60 requests/hour")

    log.info("Fetching %s %s #%d", repository, doc_type, args.number)
    try:
        if doc_type == "issue":
            opening = normalize_issue(fetch_issue(client, repository, args.number))
            comments = [
                normalize_comment(c)
                for c in fetch_issue_comments(client, repository, args.number, args.per_page)
            ]
            top_level = len(comments)
        else:
            opening, comments = fetch_discussion(client, repository, args.number)
            top_level = sum(1 for c in comments if c["reply_to"] is None)
    except FetchError as err:
        log.error("%s", err)
        return 1

    if top_level != opening["comments_count"]:
        log.warning(
            "Comment count mismatch: %s reports %d, fetched %d",
            doc_type, opening["comments_count"], top_level,
        )

    record = {
        "schema_version": "1.0",
        "document_id": document_id,
        "repository": repository,
        "type": doc_type,
        "number": args.number,
        "source_url": opening["html_url"],
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        doc_type: opening,
        "comments": comments,
    }
    out_path = args.out_dir / repository.replace("/", "__") / f"{doc_type}_{args.number}.json"
    write_json_atomic(out_path, record)
    log.info("Saved %s (%d comments)", out_path, len(comments))
    return 0


if __name__ == "__main__":
    sys.exit(main())
