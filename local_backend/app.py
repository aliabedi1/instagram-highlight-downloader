from __future__ import annotations

import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

import zipstream
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from instagrapi import Client
from instagrapi.exceptions import (
    BadPassword,
    ChallengeRequired,
    ClientConnectionError,
    ClientThrottledError,
    FeedbackRequired,
    LoginRequired,
    PleaseWaitFewMinutes,
    TwoFactorRequired,
    UserNotFound,
)
from pydantic import BaseModel, SecretStr


USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._]{1,30}$")
SESSION_TTL_SECONDS = 10 * 60
ARCHIVE_TTL_SECONDS = 30 * 60


app = FastAPI(title="Keepsake Local API", version="3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Keepsake-Session"],
)


class LoginRequest(BaseModel):
    username: str
    password: SecretStr
    verification_code: str = ""


class ScanRequest(BaseModel):
    target_username: str


class StoriesRequest(ScanRequest):
    highlight_id: str


class DownloadRequest(ScanRequest):
    highlight_titles: list[str] | None = None


@dataclass
class BrowserSession:
    token: str
    username: str
    client: Client
    created_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    scans: dict[str, dict[str, Any]] = field(default_factory=dict)
    media: dict[str, dict[str, str]] = field(default_factory=dict)
    archives: dict[str, dict[str, Any]] = field(default_factory=dict)
    request_lock: threading.Lock = field(default_factory=threading.Lock)


browser_sessions: dict[str, BrowserSession] = {}
sessions_lock = threading.Lock()


def clean_username(value: str) -> str:
    username = value.strip().lstrip("@").lower()
    if not USERNAME_PATTERN.fullmatch(username):
        raise HTTPException(status_code=400, detail="Enter a valid Instagram username.")
    return username


def clean_target(value: str) -> str:
    target = value.strip()
    if target.startswith(("http://", "https://")):
        try:
            parsed = urlparse(target)
            if parsed.hostname not in {"instagram.com", "www.instagram.com"}:
                raise HTTPException(
                    status_code=400, detail="Enter an Instagram profile link."
                )
            parts = [part for part in parsed.path.split("/") if part]
            if not parts or parts[0] in {
                "stories",
                "explore",
                "reels",
                "p",
                "accounts",
            }:
                raise HTTPException(
                    status_code=400, detail="Enter a link to an Instagram profile."
                )
            target = parts[0]
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail="Enter a valid Instagram profile link."
            ) from exc
    return clean_username(target)


def safe_name(value: str, fallback: str, limit: int = 100) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", value).strip().rstrip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:limit] or fallback


def string_url(value: Any) -> str:
    return "" if value is None else str(value)


def expire_inactive_sessions() -> None:
    now = time.time()
    with sessions_lock:
        expired = [
            token
            for token, session in browser_sessions.items()
            if now - session.last_seen > SESSION_TTL_SECONDS
        ]
        for token in expired:
            browser_sessions.pop(token, None)


def get_session(token: str | None, *, touch: bool = True) -> BrowserSession:
    expire_inactive_sessions()
    if not token:
        raise HTTPException(status_code=401, detail="Connect your Instagram account first.")
    with sessions_lock:
        session = browser_sessions.get(token)
        if session and touch:
            session.last_seen = time.time()
    if not session:
        raise HTTPException(
            status_code=401,
            detail="This browser session expired. Connect your Instagram account again.",
        )
    return session


def explain_instagram_error(exc: Exception, target: str = "") -> HTTPException:
    if isinstance(exc, UserNotFound):
        return HTTPException(status_code=404, detail=f"@{target} was not found.")
    if isinstance(exc, LoginRequired):
        return HTTPException(
            status_code=401,
            detail="Instagram ended this login session. Connect your account again.",
        )
    if isinstance(exc, (ClientThrottledError, PleaseWaitFewMinutes)):
        return HTTPException(
            status_code=429,
            detail=(
                "Instagram asked this account to slow down. Keepsake stopped immediately; "
                "wait before scanning again and do not repeatedly retry."
            ),
        )
    if isinstance(exc, FeedbackRequired):
        return HTTPException(
            status_code=403,
            detail=(
                "Instagram temporarily blocked this action. Open Instagram normally to "
                "review any account notice, then try later."
            ),
        )
    if isinstance(exc, ChallengeRequired):
        return HTTPException(
            status_code=403,
            detail=(
                "Instagram requires an account check. Complete it in the official "
                "Instagram app or website, then reconnect here."
            ),
        )
    if isinstance(exc, ClientConnectionError):
        return HTTPException(
            status_code=502,
            detail="Instagram could not complete the request. Check the connection and try once more.",
        )
    return HTTPException(
        status_code=502,
        detail=f"Instagram could not complete the request ({type(exc).__name__}).",
    )


def story_extension(story: Any, media_url: str) -> str:
    if getattr(story, "media_type", 1) == 2 or getattr(story, "video_url", None):
        return ".mp4"
    suffix = Path(urlparse(media_url).path).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".webp"} else ".jpg"


def cover_url(highlight: Any) -> str:
    cover = getattr(highlight, "cover_media", None)
    cropped = getattr(cover, "cropped_image_version", None)
    for candidate in (
        getattr(cropped, "url", None),
        getattr(cover, "thumbnail_url", None),
        getattr(getattr(highlight, "user", None), "profile_pic_url", None),
    ):
        if candidate:
            return string_url(candidate)
    return ""


def normalize_scan(profile: Any, highlights: list[Any]) -> dict[str, Any]:
    normalized_highlights: list[dict[str, Any]] = []
    used_folders: set[str] = set()

    for highlight_index, highlight in enumerate(highlights):
        title = getattr(highlight, "title", "") or f"Highlight {highlight_index + 1}"
        base_folder = safe_name(title, f"Highlight {highlight_index + 1}")
        folder = base_folder
        duplicate_index = 2
        while folder.casefold() in used_folders:
            folder = safe_name(f"{base_folder} ({duplicate_index})", base_folder)
            duplicate_index += 1
        used_folders.add(folder.casefold())

        stories: list[dict[str, Any]] = []
        for story_index, story in enumerate(getattr(highlight, "items", []) or [], start=1):
            is_video = bool(
                getattr(story, "media_type", 1) == 2
                or getattr(story, "video_url", None)
            )
            media_url = string_url(
                getattr(story, "video_url", None)
                if is_video
                else getattr(story, "thumbnail_url", None)
            )
            if not media_url:
                continue
            extension = story_extension(story, media_url)
            stories.append(
                {
                    "id": str(getattr(story, "pk", story_index)),
                    "position": story_index,
                    "type": "video" if is_video else "image",
                    "filename": f"{story_index}{extension}",
                    "media_url": media_url,
                }
            )

        normalized_highlights.append(
            {
                "id": str(getattr(highlight, "pk", highlight_index)),
                "title": title,
                "folder_name": folder,
                "cover_url": cover_url(highlight),
                "item_count": len(stories),
                "position": highlight_index,
                "stories": stories,
            }
        )

    return {
        "profile": {
            "username": str(getattr(profile, "username", "")),
            "full_name": str(getattr(profile, "full_name", "") or ""),
            "profile_pic_url": string_url(
                getattr(profile, "profile_pic_url_hd", None)
                or getattr(profile, "profile_pic_url", None)
            ),
            "is_private": bool(getattr(profile, "is_private", False)),
        },
        "highlights": normalized_highlights,
    }


def public_scan_payload(scan: dict[str, Any]) -> dict[str, Any]:
    return {
        "profile": dict(scan["profile"]),
        "highlights": [
            {key: value for key, value in highlight.items() if key not in {"stories", "folder_name"}}
            for highlight in scan["highlights"]
        ],
    }


def register_media(session: BrowserSession, story: dict[str, Any]) -> str:
    token = uuid.uuid4().hex
    session.media[token] = {
        "url": story["media_url"],
        "filename": story["filename"],
    }
    if len(session.media) > 2000:
        for stale_token in list(session.media)[:500]:
            session.media.pop(stale_token, None)
    return token


def media_chunks(session: BrowserSession, media_url: str) -> Iterator[bytes]:
    with session.request_lock:
        response = session.client.private.get(media_url, stream=True, timeout=60)
        try:
            response.raise_for_status()
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if chunk:
                    yield chunk
        finally:
            response.close()


@app.get("/api/status")
def status(
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    expire_inactive_sessions()
    if not session_token:
        return {"ready": True, "connected": False, "username": None}
    try:
        session = get_session(session_token)
    except HTTPException:
        return {"ready": True, "connected": False, "username": None}
    return {"ready": True, "connected": True, "username": session.username}


@app.post("/api/session/login")
def login(request: LoginRequest) -> dict[str, Any]:
    username = clean_username(request.username)
    password = request.password.get_secret_value()
    verification_code = re.sub(r"\s+", "", request.verification_code)
    if not password:
        raise HTTPException(status_code=400, detail="Enter your Instagram password.")
    if verification_code and not re.fullmatch(r"\d{6}|\d{8}", verification_code):
        raise HTTPException(
            status_code=400, detail="Enter the 6-digit code or an 8-digit backup code."
        )

    client = Client()
    client.delay_range = [1, 3]
    try:
        client.login(username, password, verification_code=verification_code)
    except TwoFactorRequired as exc:
        raise HTTPException(
            status_code=409,
            detail="Two-factor authentication is enabled. Enter the current code and connect again.",
        ) from exc
    except BadPassword as exc:
        raise HTTPException(
            status_code=401,
            detail="Instagram rejected that username or password.",
        ) from exc
    except Exception as exc:
        raise explain_instagram_error(exc) from exc

    # The authenticated client keeps cookies/device settings in memory. The password
    # is deliberately discarded and is never written to disk.
    client.password = ""
    token = uuid.uuid4().hex
    session = BrowserSession(token=token, username=username, client=client)
    with sessions_lock:
        browser_sessions[token] = session
    return {
        "connected": True,
        "username": username,
        "session_token": token,
        "expires_without_heartbeat_seconds": SESSION_TTL_SECONDS,
    }


@app.post("/api/session/heartbeat")
def heartbeat(
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, bool]:
    get_session(session_token)
    return {"connected": True}


@app.delete("/api/session")
def logout(
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, bool]:
    if session_token:
        with sessions_lock:
            browser_sessions.pop(session_token, None)
    return {"connected": False}


@app.post("/api/highlights/scan")
def scan_highlights(
    request: ScanRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    session = get_session(session_token)
    target = clean_target(request.target_username)
    try:
        with session.request_lock:
            profile = session.client.user_info_by_username_v1(target)
            highlights = session.client.user_highlights(str(profile.pk))
    except Exception as exc:
        raise explain_instagram_error(exc, target) from exc

    scan = normalize_scan(profile, highlights)
    session.scans[target] = scan
    return public_scan_payload(scan)


@app.post("/api/highlights/stories")
def scan_highlight_stories(
    request: StoriesRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    session = get_session(session_token)
    target = clean_target(request.target_username)
    scan = session.scans.get(target)
    if not scan:
        raise HTTPException(status_code=409, detail="Scan this profile again first.")

    highlight = next(
        (item for item in scan["highlights"] if item["id"] == request.highlight_id),
        None,
    )
    if not highlight:
        raise HTTPException(status_code=404, detail="That highlight was not found.")

    stories = []
    for story in highlight["stories"]:
        token = register_media(session, story)
        stories.append(
            {
                key: value
                for key, value in story.items()
                if key != "media_url"
            }
            | {
                "preview_url": f"http://127.0.0.1:8787/api/media/{token}?download=false",
                "download_url": f"http://127.0.0.1:8787/api/media/{token}?download=true",
            }
        )

    return {
        "profile_username": scan["profile"]["username"],
        "highlight": {
            key: value
            for key, value in highlight.items()
            if key not in {"stories", "folder_name"}
        },
        "stories": stories,
    }


@app.post("/api/highlights/download", status_code=202)
def prepare_archive(
    request: DownloadRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, str]:
    session = get_session(session_token)
    target = clean_target(request.target_username)
    scan = session.scans.get(target)
    if not scan:
        raise HTTPException(status_code=409, detail="Scan this profile again first.")

    selected = set(request.highlight_titles or [])
    highlights = [
        item
        for item in scan["highlights"]
        if not selected or item["title"] in selected
    ]
    if not highlights:
        raise HTTPException(status_code=400, detail="There are no stories to download.")

    job_id = uuid.uuid4().hex
    archive_name = (
        f"{safe_name(scan['profile']['username'], 'instagram', 30)}-highlights-"
        f"{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    )
    session.archives[job_id] = {
        "target": target,
        "titles": list(selected),
        "archive_name": archive_name,
        "created_at": time.time(),
    }
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(
    job_id: str,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    session = get_session(session_token)
    archive = session.archives.get(job_id)
    if not archive:
        raise HTTPException(status_code=404, detail="Download link not found.")
    scan = session.scans.get(archive["target"])
    if not scan:
        raise HTTPException(status_code=404, detail="The cached profile scan expired.")
    selected = set(archive["titles"])
    highlights = [
        item for item in scan["highlights"] if not selected or item["title"] in selected
    ]
    total_items = sum(len(item["stories"]) for item in highlights)
    return {
        "id": job_id,
        "status": "complete",
        "username": scan["profile"]["username"],
        "downloaded_items": total_items,
        "skipped_items": 0,
        "total_items": total_items,
        "current_highlight": "",
        "current_story": total_items,
        "current_story_total": total_items,
        "archive_name": archive["archive_name"],
    }


@app.get("/api/jobs/{job_id}/archive")
def download_archive(job_id: str) -> StreamingResponse:
    expire_inactive_sessions()
    session: BrowserSession | None = None
    archive: dict[str, Any] | None = None
    with sessions_lock:
        for candidate in browser_sessions.values():
            if job_id in candidate.archives:
                session = candidate
                archive = candidate.archives[job_id]
                candidate.last_seen = time.time()
                break
    if not session or not archive:
        raise HTTPException(status_code=404, detail="This download link expired.")
    if time.time() - archive["created_at"] > ARCHIVE_TTL_SECONDS:
        session.archives.pop(job_id, None)
        raise HTTPException(status_code=404, detail="This download link expired.")

    scan = session.scans.get(archive["target"])
    if not scan:
        raise HTTPException(status_code=404, detail="The cached profile scan expired.")
    selected = set(archive["titles"])
    highlights = [
        item for item in scan["highlights"] if not selected or item["title"] in selected
    ]

    stream = zipstream.ZipStream(compress_type=zipstream.ZIP_STORED)
    username_folder = safe_name(scan["profile"]["username"], "instagram", 30)
    for highlight in highlights:
        for story in highlight["stories"]:
            archive_path = str(
                Path(username_folder) / highlight["folder_name"] / story["filename"]
            ).replace("\\", "/")
            stream.add(
                media_chunks(session, story["media_url"]),
                arcname=archive_path,
            )

    return StreamingResponse(
        stream,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{archive["archive_name"]}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/api/media/{token}")
def download_story_media(token: str, download: bool = False) -> StreamingResponse:
    expire_inactive_sessions()
    session: BrowserSession | None = None
    media: dict[str, str] | None = None
    with sessions_lock:
        for candidate in browser_sessions.values():
            if token in candidate.media:
                session = candidate
                media = candidate.media[token]
                candidate.last_seen = time.time()
                break
    if not session or not media:
        raise HTTPException(
            status_code=404,
            detail="This media link expired. Open the highlight again.",
        )

    def stream_media() -> Iterator[bytes]:
        yield from media_chunks(session, media["url"])

    disposition = "attachment" if download else "inline"
    suffix = Path(media["filename"]).suffix.lower()
    media_type = "video/mp4" if suffix == ".mp4" else "image/jpeg"
    return StreamingResponse(
        stream_media(),
        media_type=media_type,
        headers={
            "Content-Disposition": f'{disposition}; filename="{media["filename"]}"',
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
        },
    )
