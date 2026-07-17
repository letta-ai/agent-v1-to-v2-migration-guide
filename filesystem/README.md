# Filesystem migration: folders to repositories

This example migrates document Q&A from the deprecated folders/filesystem API in `@letta-ai/letta-client` to repositories in `@letta-ai/letta-agent-sdk`.

Both versions use the [MemGPT paper](https://arxiv.org/pdf/2310.08560) and ask the same two questions.

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

`v1_example.ts` is retained as a concrete migration source; `v2_example.ts` is the working replacement.

## Setup

Requirements:

- Node.js 22+
- `curl`
- Poppler's `pdftotext`
- A `LETTA_API_KEY`

```bash
cd filesystem
npm install

curl -L https://arxiv.org/pdf/2310.08560 -o memgpt.pdf
pdftotext -layout memgpt.pdf memgpt.txt

export LETTA_API_KEY="your-key"
```

## Run

```bash
npm run check
npm run v1  # Expected to fail because the Cloud folder route is disabled.
npm run v2  # Creates a repository, asks the questions, and cleans up.
```

Set `KEEP_RESOURCES=1` to keep created resources for inspection.

## Expected v2 answer

The repository-backed agent should identify:

1. Virtual-memory paging between physical memory and disk as the operating-system mechanism. Main context maps to RAM/physical memory, while external context maps to disk storage.
2. Document analysis and multi-session chat/conversational agents as the two evaluation domains, and nested key-value retrieval as the new synthetic multi-hop task.
