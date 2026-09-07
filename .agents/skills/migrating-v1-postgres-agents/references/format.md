# Migration coverage and conversion

The script reads the retired Python server's PostgreSQL rows inside a read-only, repeatable-read transaction. It imports active agents only unless `--agent` selects specific IDs.

## Source tables

Required:

- `agents`
- `messages`

Used when present:

- `blocks_agents`
- `block` (singular)

The exporter serializes full rows with `to_jsonb(row)`, so JSON content, tool calls, timestamps, and unknown version-specific fields reach the converter unchanged.

Message order uses `messages.sequence_id`, then `created_at` and `id`. On an older schema without `sequence_id`, it uses `created_at` and `id`.

## Destination

The script writes the current local-backend layout:

```text
<storage>/agents/<base64url-agent-id>.json
<storage>/conversations/<base64url-conversation-key>/conversation.json
<storage>/conversations/<base64url-conversation-key>/manifest.json
<storage>/conversations/<base64url-conversation-key>/messages.jsonl
<storage>/memfs/<agent-id>/memory/.git
<storage>/memfs/<agent-id>/memory/system/<label>.md
```

Each transcript uses schema version 2, `pi-session-entry-jsonl`, and provider stack `pi-ai`. The current App Server reads these files but does not expose a historical-message import command. This tool therefore runs offline and is coupled to the current local storage format. Recheck the matching Letta Code source before carrying it to a later release.

## Message conversion

- `user` becomes a local user message.
- `assistant` becomes a local assistant message.
- Legacy assistant inner monologue becomes `thinking` content.
- A `send_message` call becomes visible assistant text. Its matching success tool result is dropped.
- Other tool calls and matching tool results remain linked.
- `summary` becomes a marked user message and retains the summary in message metadata.
- `system` rows are skipped because the agent record carries the system prompt.
- Soft-deleted rows are skipped.
- Unsupported roles and orphan tool results are skipped and reported as warnings.

The script preserves source message IDs and timestamps where possible. It stores the source ID again under `metadata.migrated_from`.

## Memory conversion

Attached current blocks become Markdown files:

```markdown
---
description: "Legacy block description"
---

Legacy block value
```

A label such as `human` becomes `system/human.md`. A label already under `system/` stays there. Hidden and soft-deleted blocks are skipped. If the database predates block tables, the script tries the old `agents.memory` JSON shape.

The MemFS directory is initialized as a Git repository with one import commit.

## Deliberate limits

This migration does not import:

- tools or tool source;
- model/provider configuration from the retired server;
- archival memory or passages;
- files and images that only exist outside the message row;
- block edit history;
- soft-deleted agents, messages, or blocks;
- conversation-specific block overrides.

Set `--model` to a valid model handle before starting the imported agent. The default `local/default` is only a placeholder.
