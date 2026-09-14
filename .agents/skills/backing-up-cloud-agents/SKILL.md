---
name: backing-up-cloud-agents
description: Exports a Cloud agent's settings, main chat's in-context messages, and committed Git memory history into a private folder. Creates a new Cloud agent from that backup with restored settings and memory but an empty chat. Use for Cloud agent backups, downloads, account-to-account transfers, and fresh-agent recovery without legacy agent-file import/export.
---

# Backing Up Cloud Agents

Use the bundled CLI to export one Cloud agent or restore it as a **new agent with an empty chat**. Keep the original agent and backup unchanged. Do not modify Cloud APIs or replay saved messages through inference endpoints.

## Prepare

1. Install Bun and Git. Run the commands from the repository root, or substitute the absolute path to this skill's scripts.
2. Set `LETTA_API_KEY` for the source account. For import, use an account API key that can create and access new agents, not a managed sandbox's automatically injected agent-scoped key. Such a scoped key can create an agent but lack access to retrieve or restore it. Use `--base-url https://api.letta.com` when `LETTA_BASE_URL` points elsewhere. Never place credentials in a URL or a command-line argument.
3. Pause the agent: stop turns and memory edits, disable its scheduled activity, and wait for pending memory pushes to finish. The script detects changes across its reads but cannot take an atomic server-wide snapshot.
4. Choose a **new, private folder outside any source repository or shared-memory checkout**. Treat its contents and Git history as sensitive. Credential fields are omitted from `agent.json`, but messages, custom metadata, and memory can contain secrets written by people or agents.
5. Read [references/format.md](references/format.md) for exact coverage, omitted settings, and partial-restore handling.

## Export

```bash
bun .agents/skills/backing-up-cloud-agents/scripts/cloud-agent.ts export \
  --agent agent-01234567-89ab-cdef-0123-456789abcdef \
  --out "$HOME/private-agent-backups/my-agent"
```

Inspect the reported context-message count and memory commit. Export reads only the main chat's ordered `agent.message_ids`, including any selected system/summary messages. It does not enumerate other conversations, retrieve the last N messages, or download all history. An empty ID list stays empty; a missing list fails rather than silently choosing a different scope.

The output contains:

```text
my-agent/
├── manifest.json
├── agent.json
├── messages.json
└── memory/           # Checked-out main branch and self-contained .git history
```

An existing output folder is never overwritten. Export failure removes only the new incomplete folder it created. A valid manifest is written last.

## Preview a restore

Select the destination account's `LETTA_API_KEY`, then run:

```bash
bun .agents/skills/backing-up-cloud-agents/scripts/cloud-agent.ts import \
  --from "$HOME/private-agent-backups/my-agent" \
  --name "My restored agent"
```

Review the preview. It validates JSON checksums, message selection, the committed memory tree, and Git object integrity without making API writes. If the source model is unavailable in the destination account, add `--model provider/model-name`. A different model uses its destination defaults rather than the source model settings.

## Create the new agent

Explain the loss before applying: **saved messages remain in the backup for reference and are not imported. The new main chat is empty.** Secrets, connections, tools, schedules, shared repositories, and archival memory must be configured separately.

```bash
bun .agents/skills/backing-up-cloud-agents/scripts/cloud-agent.ts import \
  --from "$HOME/private-agent-backups/my-agent" \
  --name "My restored agent" \
  --apply
```

The script creates a new agent, prints its ID immediately, restores the backup's exact memory tree and ancestry with a normal fast-forward push, recompiles its system message, and checks that the chat contains only system messages. It never force-pushes or targets the source agent's memory. Do not start a turn on the destination until this finishes.

If creation times out, inspect the destination account for an agent with the requested name before trying again. Creation is not automatically retried. If a later step fails, use the printed new ID to inspect the incomplete destination. Do not blindly repeat `--apply`, since each invocation creates another agent. Request confirmation before deleting an incomplete agent.

## Verify and resume

1. Confirm the returned new agent ID differs from the source ID.
2. Compare the returned memory tree SHA with `manifest.json`. The new commit SHA differs because it joins the backup history to the destination's initial commit.
3. Open the new agent's memory and empty main chat in Letta Code or chat.letta.com.
4. Reconnect any required tools, credentials, and shared repositories. Review the restored system prompt for references to old IDs, paths, or tools.
5. Send a new message only after those checks. Keep the backup and original agent until the restored agent works as intended.

To check the scripts locally, run:

```bash
bun test ./.agents/skills/backing-up-cloud-agents/scripts/backup.test.ts
```
