# Keepsake

Keepsake is a local Instagram highlight downloader for Windows and Linux.
Connect an Instagram account, paste a profile link, browse its highlight
stories in Instagram order, and download one story, one highlight, or the
complete collection as a ZIP.

## Requirements

- Node.js 22.13.0 or newer, with npm
- Python 3

## Windows installation and usage

Windows requires PowerShell and Python available as `python`.

1. Install the JavaScript dependencies:

   ```powershell
   npm install
   ```

2. Start Keepsake:

   ```powershell
   .\start-local.ps1
   ```

   You can also right-click `start-local.ps1` and choose **Run with
   PowerShell**.

3. Open [http://localhost:3000](http://localhost:3000).

The start script creates `.venv/` on the first run and updates the Python
packages whenever `requirements.txt` changes. Press `Ctrl+C` in the PowerShell
window to stop Keepsake.

## Linux installation and usage

Linux requires Bash, Python available as `python3`, the Python `venv` module,
and `sha256sum`. On Debian and Ubuntu, you can install the operating-system
packages with:

```bash
sudo apt update
sudo apt install python3 python3-venv coreutils
```

Then install and start Keepsake:

1. Install the JavaScript dependencies:

   ```bash
   npm install
   ```

2. Make the start script executable and run it:

   ```bash
   chmod +x start-local.sh
   ./start-local.sh
   ```

3. Open [http://localhost:3000](http://localhost:3000).

The start script creates `.venv/` on the first run and updates the Python
packages whenever `requirements.txt` changes. Press `Ctrl+C` in the terminal
to stop Keepsake.

## Use

1. Click **Connect Instagram**.
2. Enter the Instagram username and password used to view the target profile.
3. If the account uses two-factor authentication, enter its current code when
   prompted.
4. Paste the target profile link and choose **Show highlights**.
5. Select a highlight to browse its stories.
6. Download an individual story, a single highlight, or the complete ZIP.

The complete download has this structure:

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

## How it works

The platform start script (`start-local.ps1` on Windows or `start-local.sh` on
Linux) starts the local Python backend at
`http://127.0.0.1:8787` and the web interface at
`http://localhost:3000`. The browser sends requests to the local backend,
which creates the authenticated Instagram session and retrieves highlight
metadata and media.

Keepsake uses Instagram's authenticated private/mobile highlight endpoint. A
profile scan is normalized once and cached in memory for the active browser
session. Opening stories or preparing a ZIP reuses that scan instead of
repeating the profile and highlight lookup, reducing duplicate requests that
could trigger immediate `429` responses.

When a download begins, the backend fetches each media item and streams it into
the browser download. The media files and generated archive are not saved in a
project or server-side download directory.

### Session and credential handling

Instagram credentials are handled only by the local backend. The password is
discarded immediately after login. Authenticated client data, cached profile
data, media links, and ZIP links remain in memory only and are removed when you
disconnect or after the browser stops sending its heartbeat. Nothing is
written to `.sessions/` or `downloads/`.

## Notes

- Use this only for content you own or have permission to save.
- Instagram can still restrict an account, IP address, or request pattern. If
  it asks you to slow down or verify the account, stop retrying and use the
  official Instagram app or website before reconnecting.
- Keepsake is an unofficial local tool and is not affiliated with Instagram.
