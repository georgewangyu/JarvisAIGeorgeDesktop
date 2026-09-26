"""Local, deliberately narrow export of visible Desktop chat history.

This is not a profile backup or a copy of every file the assistant touched.
Only visible desktop conversations and their user/assistant messages are written.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def export_consumer_chats(db, profile_home: Path | str, output: Path | str) -> dict:
    """Atomically write JSON Lines to a new user-picked local path, mode 0600."""
    from hermes_constants import get_default_hermes_root

    home = Path(profile_home).resolve()
    target = Path(output).expanduser()
    if not target.is_absolute() or target.suffix.lower() != ".jsonl":
        raise ValueError("choose an absolute .jsonl export path")
    if target.is_symlink():
        raise ValueError("choose a regular file, not a symbolic link")
    target = target.resolve(strict=False)
    private_root = home.parent.parent if home.parent.name == "profiles" else home
    private_roots = {private_root, Path(get_default_hermes_root()).resolve(strict=False)}
    if any(target == root or root in target.parents for root in private_roots):
        raise ValueError("choose a location outside Jarvis's private data directory")
    if not target.parent.is_dir():
        raise ValueError("the export folder does not exist")
    if target.exists():
        raise ValueError("choose a new export filename; existing files are preserved")

    temp_path = None
    chats = messages = 0
    try:
        fd, temp_name = tempfile.mkstemp(prefix=".jarvis-chat-export-", suffix=".tmp", dir=target.parent)
        temp_path = Path(temp_name)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(json.dumps({"format": "jarvis-chat-history-v1", "scope": "visible desktop chats"}) + "\n")
            offset = 0
            while True:
                rows = db.search_sessions(source="desktop", limit=200, offset=offset)
                if not rows:
                    break
                offset += len(rows)
                for session in rows:
                    if session.get("hidden"):
                        continue
                    session_id = session["id"]
                    stream.write(json.dumps({"type": "chat", "id": session_id,
                                             "title": db.get_session_title(session_id) or "",
                                             "started_at": session.get("started_at"),
                                             "archived": bool(session.get("archived"))}, ensure_ascii=False) + "\n")
                    chats += 1
                    message_offset = 0
                    while True:
                        page = db.get_messages(session_id, include_compacted=True, limit=200, offset=message_offset)
                        if not page:
                            break
                        message_offset += len(page)
                        for message in page:
                            if message.get("role") not in {"user", "assistant"}:
                                continue
                            stream.write(json.dumps({"type": "message", "chat_id": session_id,
                                                     "role": message["role"],
                                                     "content": message.get("content"),
                                                     "timestamp": message.get("timestamp")},
                                                    ensure_ascii=False, default=str) + "\n")
                            messages += 1
            stream.flush()
            os.fsync(stream.fileno())
        # Publish exclusively so a file created after preflight cannot be
        # replaced. The temporary file and final path share one directory.
        try:
            os.link(temp_path, target)
        except FileExistsError as exc:
            raise ValueError("choose a new export filename; existing files are preserved") from exc
        temp_path.unlink()
        temp_path = None
        return {"output": str(target), "chats": chats, "messages": messages}
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
