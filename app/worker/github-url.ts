/**
 * Parses user input into a GitHub owner/name pair.
 *
 * Allowlist: only github.com (and www.github.com) hosts are accepted. Input may be
 * a full URL, a scheme-less "github.com/owner/name", an scp-style SSH remote, or the
 * "owner/name" shorthand. Anything after the first two path segments is ignored.
 * Case is preserved: GitHub resolves names case-insensitively and returns the
 * canonical casing, and the numeric repo id is what we key on.
 */
export type ParseResult =
  | { ok: true; owner: string; name: string }
  | { ok: false; error: string };

const ALLOWED_HOSTS = new Set(["github.com", "www.github.com"]);
const MAX_INPUT_LENGTH = 512;
// GitHub user/org login: 1-39 alphanumerics or hyphens, no leading/trailing hyphen.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// GitHub repository name: 1-100 alphanumerics, dot, underscore or hyphen.
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function parseRepositoryInput(input: unknown): ParseResult {
  if (typeof input !== "string") return fail("Expected a string");
  const raw = input.trim();
  if (raw.length === 0) return fail("Enter a GitHub repository URL or owner/name");
  if (raw.length > MAX_INPUT_LENGTH) return fail("Input is too long");

  let url: URL;
  try {
    url = new URL(toHttpsUrl(raw));
  } catch {
    return fail("Not a valid URL");
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    return fail("Only github.com repositories are supported");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return fail("Expected github.com/<owner>/<repository>");
  const owner = segments[0];
  const name = segments[1].replace(/\.git$/, "");
  if (!OWNER_RE.test(owner)) return fail(`Invalid owner "${owner}"`);
  if (!NAME_RE.test(name) || name === "." || name === "..") {
    return fail(`Invalid repository name "${name}"`);
  }
  return { ok: true, owner, name };
}

function toHttpsUrl(raw: string): string {
  const ssh = /^git@github\.com:(.+)$/i.exec(raw);
  if (ssh) return `https://github.com/${ssh[1]}`;
  if (/^(www\.)?github\.com\//i.test(raw)) return `https://${raw}`;
  if (raw.includes("://")) return raw;
  return `https://github.com/${raw}`;
}

function fail(error: string): ParseResult {
  return { ok: false, error };
}
