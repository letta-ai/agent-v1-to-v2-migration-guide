import os
import time
from pathlib import Path

from letta_client import Letta

api_key = os.environ.get("LETTA_API_KEY")
if not api_key:
    raise RuntimeError("LETTA_API_KEY is required")

paper_path = Path(os.environ.get("PAPER_PDF", "memgpt.pdf")).resolve()
suffix = format(int(time.time() * 1000), "x")
client = Letta(api_key=api_key, base_url="https://api.letta.com")

agent_id = None
folder_id = None
attached = False

question = """Use the attached MemGPT paper to answer these questions. Cite short supporting excerpts from the paper for each answer.

1. What operating-system mechanism inspired MemGPT's virtual context management, and how does the paper map the LLM's main and external context to that mechanism?
2. Which two domains were used to evaluate MemGPT, and what new synthetic retrieval task did the paper introduce?"""


def wait_for_upload(file_id: str, target_folder_id: str) -> None:
    deadline = time.monotonic() + 5 * 60

    while time.monotonic() < deadline:
        uploaded_file = client.folders.files.retrieve(
            file_id,
            folder_id=target_folder_id,
        )
        status = uploaded_file.processing_status or "unknown"
        print(f"upload status: {status}")

        if status == "completed":
            return
        if status == "error":
            raise RuntimeError(uploaded_file.error_message or "File processing failed")

        time.sleep(2)

    raise TimeoutError("Timed out waiting for file processing")


try:
    folder = client.folders.create(
        name=f"memgpt-paper-v1-python-{suffix}",
        description="MemGPT paper used for filesystem document Q&A",
        embedding="openai/text-embedding-3-small",
    )
    folder_id = folder.id

    upload = client.folders.files.upload(
        folder.id,
        file=paper_path,
        name="memgpt.pdf",
    )
    wait_for_upload(upload.id, folder.id)

    agent = client.agents.create(
        name=f"memgpt-filesystem-python-{suffix}",
        model="openai/gpt-5.2",
        embedding="openai/text-embedding-3-small",
        memory_blocks=[
            {
                "label": "persona",
                "value": (
                    "You are a careful research assistant. Answer document "
                    "questions from attached files and quote the supporting text."
                ),
            }
        ],
    )
    agent_id = agent.id

    client.agents.folders.attach(folder.id, agent_id=agent.id)
    attached = True

    response = client.agents.messages.create(
        agent_id=agent.id,
        input=question,
    )

    for message in response.messages:
        if message.message_type == "assistant_message":
            print(message.content)
finally:
    if os.environ.get("KEEP_RESOURCES") != "1":
        if attached and agent_id and folder_id:
            try:
                client.agents.folders.detach(folder_id, agent_id=agent_id)
            except Exception:
                pass
        if agent_id:
            try:
                client.agents.delete(agent_id)
            except Exception:
                pass
        if folder_id:
            try:
                client.folders.delete(folder_id)
            except Exception:
                pass
        client.close()
