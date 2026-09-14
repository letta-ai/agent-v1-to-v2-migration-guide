# Backup coverage

## Version 1 folder

- `manifest.json`: format/version, export time, source origin and agent ID, main-chat scope (`default`), ordered context IDs, JSON SHA-256 checksums, and memory commit/tree SHAs.
- `agent.json`: the retrieved Cloud agent state except `secrets`, `tool_exec_environment_variables`, and `memory_variables`. This is reference data, not a request body to replay unchanged.
- `messages.json`: one `{id, messages}` group per selected context ID, in the same order as `agent.message_ids`. Each group retains every API message variant exactly as returned by `GET /v1/messages/{id}`. One stored message can return reasoning, tool-call, and text variants; their API order is retained, not presented as a reconstructed transcript. These are API representations, not raw database rows.
- `memory/`: a clean clone of the remote `main` branch, with its reachable Git history, binary files, and skills. Its remote is removed. Other branches/tags, uncommitted local edits, Git LFS objects, submodule repositories, and separately attached shared repositories are not downloaded.

Credential-field omission is not content redaction. Keep the entire folder private, including past Git commits. Git preserves the content and file modes it tracks, not arbitrary filesystem ownership or ACLs. Export does not copy a running sandbox or the local backend's database.

The source must already have a Git memory repository with a `main` branch. A missing/inaccessible repository is an error, not permission to synthesize Git memory from potentially conflicting legacy blocks.

## Restore policy

Restore creates a new Cloud agent. It copies the name (with a ` (restored)` suffix unless overridden), description, raw system template, model handle/settings, compaction settings, response format, timezone, and file-view settings when present. With no model override, it also copies a positive `llm_config.context_window`. It does not replay the full legacy `llm_config`. Set `--model` if the saved agent lacks a usable handle.

Restore assigns the normal Letta Code/Git memory tags. It does not copy old tags, metadata, hidden flags, agent-type-specific behavior, server tools/tool rules, attached block IDs, sources, identity/project/template references, sharing grants, secrets, channels, provider connections, schedules, or shared repositories. Their source references can remain in `agent.json` for inspection; they are not portable authorization.

The raw `agent.system` template is restored, then compiled against the new agent's memory. The old compiled system message in `messages.json` is never used as the new template. Memory text is not rewritten to change embedded IDs or paths.

**No messages are restored**, including plain user/assistant text, summaries, tool calls, and tool results. `initial_message_sequence` is explicitly empty. The saved context is reference material, not resumed execution or a pending tool action. Fresh-agent creation does not currently preserve every tool-message field; this workflow deliberately avoids partial replay.

The destination's seeded Git commit and the saved memory commit become parents of one new commit whose tree exactly matches the backup. Thus source history remains reachable while the new repository accepts a regular fast-forward push. The script does not overwrite any existing agent and does not use force pushes.

Creation and Git restore are separate operations, not a transaction. A failed restore may leave a new agent behind; the script reports its ID and never deletes it automatically. A failed create request may also have succeeded remotely. Inspect the destination account before retrying.

## Local backend

This folder is not the local backend's on-disk format, and these scripts do not implement Cloud/local conversion. Keep it as the archival source if adding such an adapter: the local agent record holds fewer Cloud settings, and its message representation differs. Do not repurpose the sibling PostgreSQL migration's legacy message/block conversions for existing Cloud Git memory.

## HTTP operations

Export uses `GET /v1/agents/{id}`, `GET /v1/messages/{id}` for each selected ID, and authenticated Git reads at `/v1/git/{agent-id}/state.git`.

Import uses `POST /v1/agents` with an allowlisted body and empty `initial_message_sequence`, Git clone/push against the newly returned ID, `POST /v1/agents/{new-id}/recompile`, then agent/message reads to verify an empty chat. No normal message-send endpoint is called, and no LLM turn runs. API requests have a 60-second timeout; Git commands have a 120-second timeout. Errors omit response bodies and Git stderr because they may contain sensitive data.
