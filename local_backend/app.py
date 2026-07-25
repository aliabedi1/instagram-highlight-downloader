from __future__ import annotations

import os
import re
import subprocess
import threading
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import instaloader
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SESSION_ROOT = PROJECT_ROOT / ".sessions"
DOWNLOAD_ROOT = Path(
    os.environ.get("KEEPSAKE_DOWNLOAD_ROOT", PROJECT_ROOT / "downloads")
).resolve()
LOGIN_SCRIPT = PROJECT_ROOT / "login-instagram.ps1"
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._]{1,30}$")

SESSION_ROOT.mkdir(parents=True, exist_ok=True)
DOWNLOAD_ROOT.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Keepsake Local API", version="2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()
media_registry: dict[str, dict[str, str]] = {}
media_lock = threading.Lock()
rate_limit_until: dict[str, float] = {}
rate_limit_lock = threading.Lock()
scan_cache: dict[tuple[str, str], dict[str, Any]] = {}
scan_cache_lock = threading.Lock()
SCAN_CACHE_TTL_SECONDS = 10 * 60


class UsernameRequest(BaseModel):
    username: str


class ScanRequest(BaseModel):
    target_username: str
    session_username: str


class StoriesRequest(ScanRequest):
    highlight_id: str


class DownloadRequest(ScanRequest):
    highlight_titles: list[str] | None = None


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


def safe_folder_name(value: str, fallback: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", value).strip().rstrip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return (cleaned[:100] or fallback)


def session_path(username: str) -> Path:
    return SESSION_ROOT / f"session-{username}"


def connected_sessions() -> list[str]:
    return sorted(
        path.name.removeprefix("session-")
        for path in SESSION_ROOT.glob("session-*")
        if path.is_file() and path.stat().st_size > 0
    )


def make_loader(
    session_username: str, validate_session: bool = False
) -> instaloader.Instaloader:
    viewer = clean_username(session_username)
    path = session_path(viewer)
    if not path.exists():
        raise HTTPException(
            status_code=401,
            detail=f"No local Instagram session was found for @{viewer}. Connect it first.",
        )

    loader = instaloader.Instaloader(
        sleep=False,
        quiet=True,
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        max_connection_attempts=1,
        request_timeout=20,
        fatal_status_codes=[400, 401, 403, 404, 429],
    )
    try:
        loader.load_session_from_file(viewer, filename=str(path))
        if validate_session and loader.test_login() != viewer:
            raise HTTPException(
                status_code=401,
                detail=f"The session for @{viewer} has expired. Connect it again.",
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=401,
            detail=f"Could not load the session for @{viewer}: {exc}",
        ) from exc
    return loader


def load_profile_and_highlights(
    target_username: str, session_username: str
) -> tuple[instaloader.Instaloader, instaloader.Profile, list[instaloader.Highlight]]:
    target = clean_target(target_username)
    viewer = clean_username(session_username)
    cache_key = (viewer, target)
    now = time.time()
    with scan_cache_lock:
        cached = scan_cache.get(cache_key)
        if cached and now - cached["created_at"] < SCAN_CACHE_TTL_SECONDS:
            return cached["loader"], cached["profile"], cached["highlights"]
        if cached:
            scan_cache.pop(cache_key, None)

    with rate_limit_lock:
        remaining = rate_limit_until.get(viewer, 0) - now
    if remaining > 0:
        minutes = max(1, int(remaining / 60) + 1)
        raise HTTPException(
            status_code=429,
            detail=(
                f"Instagram rate-limited this connection. Try again in about "
                f"{minutes} minute{'s' if minutes != 1 else ''}; Keepsake has "
                "paused scans to avoid extending the limit."
            ),
        )

    loader = make_loader(viewer)
    try:
        profile = instaloader.Profile.from_username(loader.context, target)
        highlights = list(loader.get_highlights(profile))
        with scan_cache_lock:
            scan_cache[cache_key] = {
                "created_at": time.time(),
                "loader": loader,
                "profile": profile,
                "highlights": highlights,
            }
        return loader, profile, highlights
    except instaloader.exceptions.ProfileNotExistsException as exc:
        raise HTTPException(status_code=404, detail=f"@{target} was not found.") from exc
    except instaloader.exceptions.PrivateProfileNotFollowedException as exc:
        raise HTTPException(
            status_code=403,
            detail=f"@{target} is private and is not followed by the connected account.",
        ) from exc
    except instaloader.exceptions.LoginRequiredException as exc:
        raise HTTPException(
            status_code=401,
            detail="Instagram rejected the saved session. Connect your account again.",
        ) from exc
    except instaloader.exceptions.AbortDownloadException as exc:
        error_text = str(exc)
        if "429" in error_text or "Too Many Requests" in error_text:
            with rate_limit_lock:
                rate_limit_until[viewer] = time.time() + (15 * 60)
            raise HTTPException(
                status_code=429,
                detail=(
                    "Instagram has temporarily rate-limited this connection. "
                    "Wait 10–15 minutes before scanning again; repeated attempts "
                    "can extend the limit."
                ),
            ) from exc
        if "401" in error_text or "403" in error_text:
            raise HTTPException(
                status_code=401,
                detail="Instagram rejected the saved session. Connect your account again.",
            ) from exc
        if "404" in error_text:
            raise HTTPException(status_code=404, detail=f"@{target} was not found.") from exc
        raise HTTPException(
            status_code=502,
            detail=f"Instagram stopped the request: {error_text}",
        ) from exc
    except instaloader.exceptions.ConnectionException as exc:
        if "429" in str(exc) or "Too Many Requests" in str(exc):
            with rate_limit_lock:
                rate_limit_until[viewer] = time.time() + (15 * 60)
            raise HTTPException(
                status_code=429,
                detail=(
                    "Instagram has temporarily rate-limited this connection. "
                    "Wait 10–15 minutes before scanning again; repeated attempts "
                    "can extend the limit."
                ),
            ) from exc
        raise HTTPException(
            status_code=502,
            detail=f"Instagram could not complete the request: {exc}",
        ) from exc


def highlight_payload(highlight: instaloader.Highlight, index: int) -> dict[str, Any]:
    return {
        "id": str(highlight.unique_id),
        "title": highlight.title or f"Highlight {index + 1}",
        "cover_url": highlight.cover_cropped_url or highlight.cover_url,
        "item_count": highlight.itemcount,
        "position": index,
    }


def update_job(job_id: str, **changes: Any) -> None:
    with jobs_lock:
        jobs[job_id].update(changes)


def media_extension(item: instaloader.StoryItem, media_url: str) -> str:
    if item.is_video:
        return ".mp4"
    suffix = Path(urlparse(media_url).path).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".webp"} else ".jpg"


def write_media(
    loader: instaloader.Instaloader, media_url: str, destination: Path
) -> None:
    response = loader.context.get_raw(media_url)
    try:
        response.raise_for_status()
        with destination.open("wb") as output:
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if chunk:
                    output.write(chunk)
    finally:
        response.close()


def register_story_media(
    media_url: str,
    session_username: str,
    filename: str,
) -> str:
    token = uuid.uuid4().hex
    with media_lock:
        media_registry[token] = {
            "url": media_url,
            "session_username": session_username,
            "filename": filename,
        }
        if len(media_registry) > 2000:
            for stale_token in list(media_registry)[:500]:
                media_registry.pop(stale_token, None)
    return token


def story_payload(
    item: instaloader.StoryItem,
    index: int,
    session_username: str,
) -> dict[str, Any]:
    media_url = item.video_url if item.is_video else item.url
    extension = media_extension(item, media_url)
    filename = f"{index}{extension}"
    token = register_story_media(
        media_url=media_url,
        session_username=clean_username(session_username),
        filename=filename,
    )
    return {
        "id": str(item.mediaid),
        "position": index,
        "type": "video" if item.is_video else "image",
        "filename": filename,
        "preview_url": f"http://127.0.0.1:8787/api/media/{token}?download=false",
        "download_url": f"http://127.0.0.1:8787/api/media/{token}?download=true",
    }


def run_download(
    job_id: str,
    target_username: str,
    session_username: str,
    selected_titles: list[str] | None,
) -> None:
    try:
        loader, profile, highlights = load_profile_and_highlights(
            target_username, session_username
        )
        selected = set(selected_titles or [])
        if selected:
            highlights = [highlight for highlight in highlights if highlight.title in selected]

        username_folder = DOWNLOAD_ROOT / safe_folder_name(profile.username, "instagram")
        username_folder.mkdir(parents=True, exist_ok=True)
        total_items = sum(highlight.itemcount for highlight in highlights)
        downloaded = 0
        skipped = 0
        folders: list[dict[str, Any]] = []

        update_job(
            job_id,
            status="downloading",
            username=profile.username,
            total_items=total_items,
            total_highlights=len(highlights),
        )

        for highlight_index, highlight in enumerate(highlights):
            folder_name = safe_folder_name(
                highlight.title, f"Highlight {highlight_index + 1}"
            )
            highlight_folder = username_folder / folder_name
            highlight_folder.mkdir(parents=True, exist_ok=True)
            items = list(highlight.get_items())
            highlight_downloaded = 0

            update_job(
                job_id,
                current_highlight=highlight.title,
                current_highlight_index=highlight_index + 1,
            )

            for story_index, item in enumerate(items, start=1):
                media_url = item.video_url if item.is_video else item.url
                extension = media_extension(item, media_url)
                destination = highlight_folder / f"{story_index}{extension}"

                update_job(
                    job_id,
                    current_story=story_index,
                    current_story_total=len(items),
                )

                if destination.exists() and destination.stat().st_size > 0:
                    skipped += 1
                    downloaded += 1
                    continue

                write_media(loader, media_url, destination)
                downloaded += 1
                highlight_downloaded += 1
                update_job(job_id, downloaded_items=downloaded, skipped_items=skipped)

            folders.append(
                {
                    "title": highlight.title,
                    "path": str(highlight_folder),
                    "downloaded": highlight_downloaded,
                    "total": len(items),
                }
            )

        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        archive_path = DOWNLOAD_ROOT / f"{profile.username}-highlights-{timestamp}.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            for folder in folders:
                highlight_path = Path(folder["path"])
                highlight_name = highlight_path.name
                for media_file in sorted(
                    highlight_path.iterdir(),
                    key=lambda path: int(path.stem) if path.stem.isdigit() else 10**9,
                ):
                    if media_file.is_file() and media_file.stem.isdigit():
                        archive.write(
                            media_file,
                            arcname=str(
                                Path(profile.username)
                                / highlight_name
                                / media_file.name
                            ),
                        )

        update_job(
            job_id,
            status="complete",
            downloaded_items=downloaded,
            skipped_items=skipped,
            output_path=str(username_folder),
            archive_path=str(archive_path),
            archive_name=archive_path.name,
            folders=folders,
        )
    except HTTPException as exc:
        update_job(job_id, status="error", error=str(exc.detail))
    except Exception as exc:
        update_job(job_id, status="error", error=f"Download failed: {exc}")


@app.get("/api/status")
def status() -> dict[str, Any]:
    return {
        "ready": True,
        "sessions": connected_sessions(),
        "download_root": str(DOWNLOAD_ROOT),
    }


@app.post("/api/session/login")
def start_login(request: UsernameRequest) -> dict[str, str]:
    username = clean_username(request.username)
    if not LOGIN_SCRIPT.exists():
        raise HTTPException(status_code=500, detail="The local login helper is missing.")

    command = [
        "powershell.exe",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(LOGIN_SCRIPT),
        username,
    ]
    creation_flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    subprocess.Popen(
        command,
        cwd=str(PROJECT_ROOT),
        creationflags=creation_flags,
        close_fds=True,
    )
    return {
        "message": (
            f"A secure login terminal was opened for @{username}. "
            "Complete it there, then return to Keepsake."
        )
    }


@app.post("/api/highlights/scan")
def scan_highlights(request: ScanRequest) -> dict[str, Any]:
    _, profile, highlights = load_profile_and_highlights(
        request.target_username, request.session_username
    )
    return {
        "profile": {
            "username": profile.username,
            "full_name": profile.full_name,
            "profile_pic_url": profile.profile_pic_url,
            "is_private": profile.is_private,
            "biography": profile.biography,
            "posts": profile.mediacount,
            "followers": profile.followers,
            "following": profile.followees,
        },
        "highlights": [
            highlight_payload(highlight, index)
            for index, highlight in enumerate(highlights)
        ],
        "download_path": str(DOWNLOAD_ROOT / profile.username),
    }


@app.post("/api/highlights/stories")
def scan_highlight_stories(request: StoriesRequest) -> dict[str, Any]:
    _, profile, highlights = load_profile_and_highlights(
        request.target_username, request.session_username
    )
    highlight = next(
        (
            item
            for item in highlights
            if str(item.unique_id) == str(request.highlight_id)
        ),
        None,
    )
    if highlight is None:
        raise HTTPException(status_code=404, detail="That highlight was not found.")

    stories = [
        story_payload(item, index, request.session_username)
        for index, item in enumerate(highlight.get_items(), start=1)
    ]

    return {
        "profile_username": profile.username,
        "highlight": highlight_payload(highlight, 0),
        "stories": stories,
    }


@app.post("/api/stories/active")
def scan_active_stories(request: ScanRequest) -> dict[str, Any]:
    loader, profile, _ = load_profile_and_highlights(
        request.target_username, request.session_username
    )
    try:
        trays = list(loader.get_stories(userids=[profile.userid]))
        items = list(trays[0].get_items()) if trays else []
    except instaloader.exceptions.LoginRequiredException as exc:
        raise HTTPException(
            status_code=401,
            detail="Instagram rejected the saved session. Connect your account again.",
        ) from exc
    except instaloader.exceptions.ConnectionException as exc:
        if "429" in str(exc) or "Too Many Requests" in str(exc):
            with rate_limit_lock:
                rate_limit_until[clean_username(request.session_username)] = (
                    time.time() + (10 * 60)
                )
            raise HTTPException(
                status_code=429,
                detail=(
                    "Instagram temporarily rate-limited this connection. "
                    "Wait about 10 minutes before trying again."
                ),
            ) from exc
        raise HTTPException(
            status_code=502,
            detail=f"Instagram could not load current stories: {exc}",
        ) from exc

    return {
        "profile_username": profile.username,
        "stories": [
            story_payload(item, index, request.session_username)
            for index, item in enumerate(items, start=1)
        ],
    }


@app.post("/api/highlights/download", status_code=202)
def download_highlights(request: DownloadRequest) -> dict[str, str]:
    target = clean_target(request.target_username)
    viewer = clean_username(request.session_username)
    if viewer not in connected_sessions():
        raise HTTPException(status_code=401, detail=f"Connect @{viewer} first.")

    job_id = uuid.uuid4().hex
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "username": target,
            "downloaded_items": 0,
            "skipped_items": 0,
            "total_items": 0,
            "current_highlight": "",
            "current_story": 0,
            "current_story_total": 0,
        }

    thread = threading.Thread(
        target=run_download,
        args=(
            job_id,
            target,
            viewer,
            request.highlight_titles,
        ),
        daemon=True,
    )
    thread.start()
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Download job not found.")
        return dict(job)


@app.get("/api/jobs/{job_id}/archive")
def download_archive(job_id: str) -> FileResponse:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Download job not found.")
        if job.get("status") != "complete" or not job.get("archive_path"):
            raise HTTPException(status_code=409, detail="The ZIP archive is not ready yet.")
        archive_path = Path(job["archive_path"])
        archive_name = str(job["archive_name"])

    if not archive_path.exists():
        raise HTTPException(status_code=404, detail="The ZIP archive is no longer available.")
    return FileResponse(
        archive_path,
        media_type="application/zip",
        filename=archive_name,
    )


@app.get("/api/media/{token}")
def download_story_media(token: str, download: bool = False) -> StreamingResponse:
    with media_lock:
        media = media_registry.get(token)
    if not media:
        raise HTTPException(
            status_code=404,
            detail="This media preview expired. Open the highlight again.",
        )

    loader = make_loader(media["session_username"])
    response = loader.context.get_raw(media["url"])
    response.raise_for_status()
    content_type = response.headers.get("content-type", "application/octet-stream")

    def stream_media():
        try:
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if chunk:
                    yield chunk
        finally:
            response.close()

    disposition = "attachment" if download else "inline"
    return StreamingResponse(
        stream_media(),
        media_type=content_type,
        headers={
            "Content-Disposition": f'{disposition}; filename="{media["filename"]}"',
            "Cache-Control": "private, max-age=300",
        },
    )


@app.post("/api/open-downloads")
def open_downloads() -> dict[str, str]:
    DOWNLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    os.startfile(DOWNLOAD_ROOT)  # type: ignore[attr-defined]
    return {"path": str(DOWNLOAD_ROOT)}
