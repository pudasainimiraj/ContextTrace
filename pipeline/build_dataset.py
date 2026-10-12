#!/usr/bin/env python3
"""Assemble one dataset file from per-document passage files and the curated question metadata.

Usage:
    python build_dataset.py --curated Contexttrace_dagster_20_Passages.json \
        --out data/passages/contexttrace_dagster_passages.json \
        data/passages/dagster-io__dagster/*.json

Each document in the curated file is matched by number to a passage file
written by chunk_passages.py. The output keeps the curated question, answer,
and answer_status, and replaces the paraphrased passages with the normalized,
source-linked passages from the pipeline.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

from fetch_github import write_json_atomic

log = logging.getLogger("build_dataset")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Assemble one dataset file from passage files.")
    parser.add_argument("inputs", nargs="+", type=Path, help="passage files from chunk_passages.py")
    parser.add_argument("--curated", required=True, type=Path, help="curated passages file")
    parser.add_argument("--out", required=True, type=Path, help="dataset file to write")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr
    )

    with open(args.curated, encoding="utf-8") as fh:
        curated = json.load(fh)
    by_number: dict[int, dict] = {}
    for path in args.inputs:
        with open(path, encoding="utf-8") as fh:
            record = json.load(fh)
        by_number[record["number"]] = record

    documents = []
    missing = []
    for doc in curated["documents"]:
        record = by_number.get(doc["number"])
        if record is None:
            missing.append(doc["number"])
            continue
        documents.append(
            {
                "number": record["number"],
                "type": record["type"],
                "title": record["title"],
                "question": doc["question"],
                "answer_status": doc["answer_status"],
                "answer": doc["answer"],
                "document_id": record["document_id"],
                "source_url": record["source_url"],
                "fetched_at": record["fetched_at"],
                "passage_count": record["passage_count"],
                "passages": record["passages"],
            }
        )
    if missing:
        raise SystemExit(f"No passage file given for documents: {missing}")

    settings = {(r["tokenizer"], r["max_tokens"]) for r in by_number.values()}
    if len(settings) != 1:
        raise SystemExit(f"Passage files were made with different settings: {sorted(settings)}")
    tokenizer, max_tokens = settings.pop()

    output = {
        "schema_version": "1.0",
        "repository": curated["repository"],
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "document_definition": (
            "Thread-level source container. Each passage is a normalized, verbatim chunk of one "
            "source unit (the opening body or one comment) and links to that unit."
        ),
        "tokenizer": tokenizer,
        "max_tokens": max_tokens,
        "passage_count": sum(d["passage_count"] for d in documents),
        "documents": documents,
    }
    write_json_atomic(args.out, output)
    log.info("Saved %s (%d documents, %d passages)", args.out, len(documents), output["passage_count"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
