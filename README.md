# Letta Agent v1 to v2 migration guide

Side-by-side examples for migrating from deprecated Letta API and SDK surfaces to the Letta Agent SDK.

## Guides

- [Async messages to Agent SDK sessions](./async-messages/README.md)
- [Filesystem folders to repositories](./filesystem/README.md)
- [Python server PostgreSQL agents to the local App Server](./.agents/skills/migrating-v1-postgres-agents/SKILL.md)
- [Cloud agent backup and fresh-agent restore](./.agents/skills/backing-up-cloud-agents/SKILL.md) (settings and Git memory restored; saved messages kept for reference)

API guides keep the v1 and v2 implementations close together so behavior can be compared directly. State migrations include a runnable skill and validation scripts.
