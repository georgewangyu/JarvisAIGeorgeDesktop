"""Shared creation proof for the standalone headless event module and gateway.

Kept separate because ``python -m tui_gateway.headless_owner_event`` runs the
consumer as ``__main__`` while the gateway imports it by package name.
"""

from contextvars import ContextVar

resume_creation_token: ContextVar[str | None] = ContextVar(
    "jarvis_headless_resume_creation_token", default=None)
