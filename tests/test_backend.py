from __future__ import annotations

import importlib
import io
import unittest
import zipfile
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from instagrapi.exceptions import TwoFactorRequired


backend = importlib.import_module("local_backend.app")


def sample_profile():
    return SimpleNamespace(
        pk="42",
        username="target",
        full_name="Target User",
        profile_pic_url="https://cdn.example/profile.jpg",
        profile_pic_url_hd=None,
        is_private=False,
    )


def sample_highlight():
    story = SimpleNamespace(
        pk="101",
        media_type=1,
        video_url=None,
        thumbnail_url="https://cdn.example/story.jpg",
    )
    cover = SimpleNamespace(
        cropped_image_version=SimpleNamespace(url="https://cdn.example/cover.jpg"),
        thumbnail_url=None,
    )
    return SimpleNamespace(
        pk="9001",
        title="Travel",
        cover_media=cover,
        user=None,
        items=[story],
    )


class BackendFlowTests(unittest.TestCase):
    def setUp(self):
        with backend.sessions_lock:
            backend.browser_sessions.clear()
        self.client = TestClient(backend.app)

    def login(self, fake_client: Mock) -> str:
        with patch.object(backend, "Client", return_value=fake_client):
            response = self.client.post(
                "/api/session/login",
                json={"username": "viewer", "password": "secret", "verification_code": ""},
            )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["session_token"]

    def test_session_scan_cache_and_streamed_archive(self):
        fake_client = Mock()
        fake_client.password = "secret"
        fake_client.login.return_value = True
        fake_client.user_info_by_username_v1.return_value = sample_profile()
        fake_client.user_highlights.return_value = [sample_highlight()]
        token = self.login(fake_client)
        headers = {"X-Keepsake-Session": token}

        self.assertEqual(fake_client.password, "")
        scan = self.client.post(
            "/api/highlights/scan",
            headers=headers,
            json={"target_username": "https://www.instagram.com/target/"},
        )
        self.assertEqual(scan.status_code, 200, scan.text)
        self.assertEqual(scan.json()["highlights"][0]["item_count"], 1)

        stories = self.client.post(
            "/api/highlights/stories",
            headers=headers,
            json={"target_username": "target", "highlight_id": "9001"},
        )
        self.assertEqual(stories.status_code, 200, stories.text)
        self.assertEqual(stories.json()["stories"][0]["filename"], "1.jpg")

        prepared = self.client.post(
            "/api/highlights/download",
            headers=headers,
            json={"target_username": "target", "highlight_titles": None},
        )
        self.assertEqual(prepared.status_code, 202, prepared.text)
        job_id = prepared.json()["job_id"]

        ready = self.client.get(f"/api/jobs/{job_id}", headers=headers)
        self.assertEqual(ready.status_code, 200, ready.text)
        self.assertEqual(ready.json()["status"], "complete")

        with patch.object(backend, "media_chunks", return_value=iter([b"image-bytes"])):
            archive = self.client.get(f"/api/jobs/{job_id}/archive")
        self.assertEqual(archive.status_code, 200, archive.text)
        with zipfile.ZipFile(io.BytesIO(archive.content)) as downloaded_zip:
            self.assertEqual(downloaded_zip.namelist(), ["target/Travel/1.jpg"])
            self.assertEqual(downloaded_zip.read("target/Travel/1.jpg"), b"image-bytes")

        # Opening stories and preparing the ZIP must reuse the original scan.
        fake_client.user_info_by_username_v1.assert_called_once_with("target")
        fake_client.user_highlights.assert_called_once_with("42")

    def test_two_factor_login_requests_a_code_without_creating_session(self):
        fake_client = Mock()
        fake_client.login.side_effect = TwoFactorRequired("two_factor_required")
        with patch.object(backend, "Client", return_value=fake_client):
            response = self.client.post(
                "/api/session/login",
                json={"username": "viewer", "password": "secret", "verification_code": ""},
            )
        self.assertEqual(response.status_code, 409)
        self.assertIn("Two-factor", response.json()["detail"])
        self.assertEqual(backend.browser_sessions, {})

    def test_logout_removes_in_memory_session(self):
        fake_client = Mock()
        fake_client.password = "secret"
        fake_client.login.return_value = True
        token = self.login(fake_client)
        response = self.client.delete(
            "/api/session", headers={"X-Keepsake-Session": token}
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(token, backend.browser_sessions)


if __name__ == "__main__":
    unittest.main()
