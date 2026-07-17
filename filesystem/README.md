# Filesystem migration: folders to repositories

This example migrates document Q&A from the deprecated folders/filesystem API to v2 repositories.

The TypeScript examples use `@letta-ai/letta-client` for v1 and `@letta-ai/letta-agent-sdk` for v2. They both use the [MemGPT paper](https://arxiv.org/pdf/2310.08560) and ask the same two questions.

Python's v1 example uses `letta-client`. The v2 Agent SDK is currently TypeScript-only, so `v2_example.py` demonstrates the Python-accessible repositories HTTP API—create, write, list versions, and optionally attach to an existing agent—while `v2_example.ts` remains the end-to-end repository-backed Agent SDK session example.

## What changed

| v1 folders/filesystem | v2 repositories |
| --- | --- |
| A folder has an embedding model. | A repository is a git-tracked text filesystem. |
| PDFs are uploaded as multipart files. | Repository file content is written as text. |
| The server parses, chunks, and embeds uploads asynchronously. | The caller extracts text before writing it to the repository. |
| A folder is attached directly to an agent. | A repository is passed as a session resource. |
| The agent receives `search_file`, `grep_file`, and `open_file`. | The repository is materialized in the agent environment and read with filesystem tools. |
| Folder attachment persists until explicitly detached. | SDK-created session attachment is removed when the session closes. |

The v1 folder endpoint is no longer supported on Letta Cloud. As of July 17, 2026, `client.folders.create(...)` returns HTTP 400:

```text
This API route is deprecated and no longer supported on the Letta API.
```

`v1_example.ts` and `v1_example.py` are retained as concrete migration sources. `v2_example.ts` is the complete working replacement; `v2_example.py` covers repository management until a native Python Agent SDK is available.

## Setup

Requirements:

- Node.js 22+ for TypeScript
- Python 3.9+ for Python
- `curl`
- Poppler's `pdftotext`
- A `LETTA_API_KEY`

```bash
cd filesystem
npm install
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

curl -L https://arxiv.org/pdf/2310.08560 -o memgpt.pdf
pdftotext -layout memgpt.pdf memgpt.txt

export LETTA_API_KEY="your-key"
```

## Run

TypeScript:

```bash
npm run check
npm run v1  # Expected to fail because the Cloud folder route is disabled.
npm run v2  # Creates a repository, asks the questions, and cleans up.
```

Python:

```bash
python v1_example.py  # Expected to fail for the same deprecated route.
python v2_example.py  # Exercises repository CRUD and version history.
```

Set `TARGET_AGENT_ID` before `v2_example.py` to also attach the repository to an existing agent. Python does not yet have the Agent SDK session API needed to run the same managed repository-backed Q&A turn; use `v2_example.ts` for that part.

Set `KEEP_RESOURCES=1` to keep created resources for inspection.

## Expected v2 answer

The repository-backed agent should identify:

1. Virtual-memory paging between physical memory and disk as the operating-system mechanism. Main context maps to RAM/physical memory, while external context maps to disk storage.
2. Document analysis and multi-session chat/conversational agents as the two evaluation domains, and nested key-value retrieval as the new synthetic multi-hop task.
