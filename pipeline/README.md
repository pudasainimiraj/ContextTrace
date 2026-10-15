# Python prototype

This directory is the first, local prototype of ContextTrace. `fetch_github.py` pulls the issues and discussions of one repository into `data/github/`, `markdown_normalize.py` turns GitHub Markdown into plain text, `chunk_passages.py` splits each opening post and comment into passages under a token budget, and `build_dataset.py` writes the result to `data/passages/`. `tests/` holds the fixture records and the reference tests.

The Cloudflare Worker under `worker/src/etl/` is a port of this code: `normalize.ts`, `chunk.ts` and `passages.ts` name the Python file they port in their header comment, and `tests/fixtures/` at the repository root copies the records from `pipeline/tests/fixtures/` so that both implementations are checked against the same cases.

The prototype is kept as the readable specification. It is not deployed, and nothing in the Worker imports it.
