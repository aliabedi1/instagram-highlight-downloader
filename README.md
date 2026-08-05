# Keepsake

Keepsake is a local Instagram highlight downloader for Windows. Sign in for the
current browser tab, paste a profile link, browse its highlight stories in
Instagram order, and download one story or the complete collection as a ZIP.

The ZIP keeps a clean structure:

```text
username-highlights-YYYYMMDD-HHMMSS.zip
└── username/
    ├── Highlight name/
    │   ├── 1.jpg
    │   ├── 2.mp4
    │   └── 3.jpg
    └── Another highlight/
        └── 1.jpg
```

## Start

Right-click `start-local.ps1` and choose **Run with PowerShell**, or run:

```powershell
.\start-local.ps1
```

Then open [http://localhost:3000](http://localhost:3000).

The start script automatically creates `.venv/` and updates Python packages
whenever `requirements.txt` changes.

## Use

1. Click **Connect Instagram**.
2. Enter the Instagram username and password used to view the target profile.
3. If the account uses two-factor authentication, enter its current code when
   prompted.
4. Paste a target profile link and choose **Show highlights**.
5. Download one story, or prepare and download the complete ZIP.

Instagram credentials are handled only by the local backend. The password is
discarded immediately after login. Authenticated client data, cached profile
data, media links, and ZIP links are held in memory only; they are removed when
you disconnect or after the browser stops sending its heartbeat. Nothing is
written to `.sessions/` or `downloads/`.

The complete ZIP is generated while the browser downloads it. Media and archive
files are not saved to a project or server-side download directory.

## Why the scan flow changed

The previous implementation used Instaloader's web GraphQL highlight path and
repeated the same profile/highlight scan when opening stories or starting a ZIP.
That could produce immediate `429` responses and multiply requests. Keepsake now
uses an authenticated private/mobile highlight endpoint and caches one normalized
scan for the lifetime of the active browser session.

## Notes

- Use this only for content you own or have permission to save.
- Instagram can still restrict an account, IP address, or request pattern. If it
  asks you to slow down or verify the account, stop retrying and use the official
  Instagram app or website before reconnecting.
- Keepsake is an unofficial local tool and is not affiliated with Instagram.
