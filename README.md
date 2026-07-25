# Keepsake

A private Instagram story and highlight saver for Windows. Paste a public
profile link, switch between its current stories and highlights, download
individual media, or download every highlight as one organized ZIP:

```text
downloads/
└── username/
    ├── Highlight name/
    │   ├── 1.jpg
    │   ├── 2.mp4
    │   └── 3.jpg
    └── Another highlight/
        └── 1.jpg
```

The ZIP preserves the same structure:

```text
username-highlights-YYYYMMDD-HHMMSS.zip
└── username/
    └── Highlight name/
        ├── 1.jpg
        ├── 2.mp4
        └── 3.jpg
```

## Start

Right-click `start-local.ps1` and choose **Run with PowerShell**, or run:

```powershell
.\start-local.ps1
```

Then open [http://localhost:3000](http://localhost:3000).

## First use

Instagram requires a logged-in viewer session to list stories and highlights,
including for public profiles.

1. In Keepsake, click **Connect another account**.
2. Enter your Instagram username.
3. Complete password and two-factor authentication in the separate terminal.
4. Return to Keepsake and click **Refresh**.
5. Paste the target profile link and click **Show stories**.
6. Switch between current stories and highlights. Open any highlight to preview
   and download its media, or choose
   **Download all as ZIP**.

Keepsake never receives or saves your Instagram password. Instaloader stores a
reusable local session under `.sessions/`, which is excluded from Git.

## Local folders

- Downloads: `downloads/`
- Instagram sessions: `.sessions/`
- Python environment: `.venv/`

Set `KEEPSAKE_DOWNLOAD_ROOT` before starting the app to use a different
download directory.

## Notes

- Use this only for content you own or have permission to save.
- Instagram may rate-limit repeated requests.
- Keepsake caches a profile scan for ten minutes so opening highlights does not
  repeat the same Instagram request.
- If a session expires, connect the viewer account again.
