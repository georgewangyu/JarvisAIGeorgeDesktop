"""Explicit Feed generation API for the desktop and dashboard."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from hermes_cli.feed_editions import get_edition, list_editions, request_edition
from hermes_cli.web_server_profiles import _config_profile_scope

router = APIRouter()


class GenerateFeedRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    retry_id: Optional[str] = None
    liked_edition_ids: list[str] = Field(default_factory=list, max_length=5)
    # Values are "editionId:index" (zero-based) from complete, profile-owned stories.
    # Device-local Love only reaches generation when explicitly included here.
    liked_story_ids: list[str] = Field(default_factory=list, max_length=5)


@contextmanager
def _feed_profile_scope(profile: Optional[str]):
    # Resolve and validate the dashboard profile. The config scope binds home
    # and credentials; terminal scope prevents borrowing the launch policy.
    from hermes_constants import get_hermes_home
    from tools.terminal_scope import install_and_reset_profile_terminal_scope

    with _config_profile_scope(profile):
        with install_and_reset_profile_terminal_scope(get_hermes_home()):
            yield


def _list(profile: Optional[str], limit: int):
    with _feed_profile_scope(profile):
        return list_editions(limit)


def _get(profile: Optional[str], edition_id: str):
    with _feed_profile_scope(profile):
        return get_edition(edition_id)


def _generate(profile: Optional[str], body: GenerateFeedRequest):
    with _feed_profile_scope(profile):
        return request_edition(
            body.prompt, retry_id=body.retry_id,
            liked_edition_ids=body.liked_edition_ids,
            liked_story_ids=body.liked_story_ids,
        )


@router.get("/api/feed/editions")
async def feed_editions(profile: Optional[str] = None, limit: int = 20):
    return {"editions": await asyncio.to_thread(_list, profile, limit)}


@router.get("/api/feed/editions/{edition_id}")
async def feed_edition(edition_id: str, profile: Optional[str] = None):
    row = await asyncio.to_thread(_get, profile, edition_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Feed edition not found")
    return {"edition": row}


@router.post("/api/feed/editions", status_code=202)
async def generate_feed_edition(body: GenerateFeedRequest, profile: Optional[str] = None):
    try:
        row = await asyncio.to_thread(_generate, profile, body)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"edition": row}
