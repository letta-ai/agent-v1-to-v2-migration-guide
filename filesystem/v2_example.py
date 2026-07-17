"""Manage v2 repositories from Python through their HTTP API.

The Letta Agent SDK is currently TypeScript-only. This Python example covers
repository creation, text-file writes, listing/version history, and optional
attachment to an existing agent. Use v2_example.ts when you also need to create
a managed Agent SDK session and ask the agent questions about the repository.
"""

import os
import time
from pathlib import Path
from typing import Any, Dict

import httpx

api_key = os.environ.get("LETTA_API_KEY")
if not api_key:
    raise RuntimeError("LETTA_API_KEY is required")

paper_text = (
    Path(os.environ.get("PAPER_TEXT", "memgpt.txt"))
    .resolve()
    .read_text(encoding="utf-8", errors="replace")
)
agent_id = os.environ.get("TARGET_AGENT_ID")
suffix = format(int(time.time() * 1000), "x")

repository_id = None
attached = False

with httpx.Client(
    base_url="https://api.letta.com",
    headers={"Authorization": f"Bearer {api_key}"},
    timeout=120,
) as client:

    def api(method: str, path: str, **kwargs: Any) -> Dict[str, Any]:
        response = client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()

    try:
        repository = api(
            "POST",
            "/v1/repositories",
            json={"name": f"memgpt-paper-v2-python-{suffix}"},
        )
        repository_id = repository["id"]
        print(f"repository: {repository_id}")

        mutation = api(
            "POST",
            f"/v1/repositories/{repository_id}/files",
            json={
                "path": "papers/memgpt.txt",
                "content": paper_text,
            },
        )
        print(f"file commit: {mutation['commit_sha']}")

        files = api(
            "GET",
            f"/v1/repositories/{repository_id}/files",
            params={"path_prefix": "papers/"},
        )
        print("files:", ", ".join(item["path"] for item in files["files"]))

        versions = api(
            "GET",
            f"/v1/repositories/{repository_id}/versions",
            params={"path": "papers/memgpt.txt", "limit": 20},
        )
        commits = versions.get("commits", versions.get("versions", versions))
        print(f"versions: {len(commits)}")

        if agent_id:
            api(
                "POST",
                f"/v1/agents/{agent_id}/repositories",
                json={"repository_id": repository_id},
            )

            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                linked = api("GET", f"/v1/agents/{agent_id}/repositories")
                if any(repo["id"] == repository_id for repo in linked["repositories"]):
                    attached = True
                    break
                time.sleep(0.25)

            if not attached:
                raise TimeoutError("Repository attachment did not become visible")
            print(f"attached to agent: {agent_id}")
        else:
            print(
                "Set TARGET_AGENT_ID to demonstrate persistent attachment. "
                "Use v2_example.ts for the full session-scoped document Q&A flow."
            )
    finally:
        if os.environ.get("KEEP_RESOURCES") != "1":
            if attached and agent_id and repository_id:
                response = client.delete(
                    f"/v1/agents/{agent_id}/repositories/{repository_id}"
                )
                if response.status_code not in (200, 204, 404):
                    response.raise_for_status()

            if repository_id:
                response = client.delete(f"/v1/repositories/{repository_id}")
                if response.status_code not in (200, 204, 404):
                    response.raise_for_status()
