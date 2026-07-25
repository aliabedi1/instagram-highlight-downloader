"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const API = "http://127.0.0.1:8787/api";

type Highlight = {
  id: string;
  title: string;
  cover_url: string;
  item_count: number;
  position: number;
};

type ScanResult = {
  profile: {
    username: string;
    full_name: string;
    profile_pic_url: string;
    is_private: boolean;
  };
  highlights: Highlight[];
  download_path: string;
};

type Story = {
  id: string;
  position: number;
  type: "image" | "video";
  filename: string;
  preview_url: string;
  download_url: string;
};

type StoryResult = {
  highlight: Highlight;
  stories: Story[];
};

type Job = {
  id: string;
  status: "queued" | "downloading" | "complete" | "error";
  username: string;
  downloaded_items: number;
  skipped_items: number;
  total_items: number;
  current_highlight: string;
  current_story: number;
  current_story_total: number;
  output_path?: string;
  archive_name?: string;
  error?: string;
};

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4.2" />
      <circle className="dot" cx="17.4" cy="6.7" r="1" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7.5h7l2-2h9v14H3z" />
    </svg>
  );
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${API}${path}`, {
      ...options,
      signal: options?.signal || controller.signal,
      headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Something went wrong.");
    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        "Instagram did not respond within 30 seconds. The scan was stopped; wait a few minutes before trying again.",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export default function Home() {
  const [target, setTarget] = useState("");
  const [viewer, setViewer] = useState("");
  const [sessions, setSessions] = useState<string[]>([]);
  const [downloadRoot, setDownloadRoot] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<Highlight | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [storiesLoading, setStoriesLoading] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [status, setStatus] = useState<"idle" | "scanning" | "error">("idle");
  const [message, setMessage] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginName, setLoginName] = useState("");

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api<{ sessions: string[]; download_root: string }>("/status");
      setSessions(data.sessions);
      setDownloadRoot(data.download_root);
      setViewer((current) => current || data.sessions[0] || "");
      setMessage("");
    } catch {
      setMessage("The local download service is not running. Start the app with start-local.ps1.");
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!job || !["queued", "downloading"].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api<Job>(`/jobs/${job.id}`);
        setJob(next);
      } catch (error) {
        setJob((current) =>
          current ? { ...current, status: "error", error: String(error) } : null,
        );
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [job]);

  const progress = useMemo(() => {
    if (!job?.total_items) return 0;
    return Math.min(100, Math.round((job.downloaded_items / job.total_items) * 100));
  }, [job]);

  async function handleScan(event: FormEvent) {
    event.preventDefault();
    setStatus("scanning");
    setMessage("");
    setScan(null);
    setJob(null);
    try {
      const data = await api<ScanResult>("/highlights/scan", {
        method: "POST",
        body: JSON.stringify({
          target_username: target,
          session_username: viewer,
        }),
      });
      setScan(data);
      setStatus("idle");
      if (data.highlights[0]) {
        await loadStories(data.highlights[0], data.profile.username);
      }
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not load highlights.");
    }
  }

  async function loadStories(highlight: Highlight, profileUsername?: string) {
    setActiveHighlight(highlight);
    setStories([]);
    setStoriesLoading(true);
    setMessage("");
    try {
      const data = await api<StoryResult>("/highlights/stories", {
        method: "POST",
        body: JSON.stringify({
          target_username: profileUsername || scan?.profile.username || target,
          session_username: viewer,
          highlight_id: highlight.id,
        }),
      });
      setStories(data.stories);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not open that highlight.",
      );
    } finally {
      setStoriesLoading(false);
    }
  }

  async function connectSession() {
    try {
      const data = await api<{ message: string }>("/session/login", {
        method: "POST",
        body: JSON.stringify({ username: loginName }),
      });
      setMessage(data.message);
      setLoginOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open login.");
    }
  }

  async function startDownload() {
    if (!scan) return;
    setMessage("");
    try {
      const data = await api<{ job_id: string }>("/highlights/download", {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          session_username: viewer,
          highlight_titles: null,
        }),
      });
      setJob({
        id: data.job_id,
        status: "queued",
        username: scan.profile.username,
        downloaded_items: 0,
        skipped_items: 0,
        total_items: scan.highlights.reduce(
          (sum, highlight) => sum + highlight.item_count,
          0,
        ),
        current_highlight: "",
        current_story: 0,
        current_story_total: 0,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Download could not start.");
    }
  }

  async function openDownloads() {
    await api("/open-downloads", { method: "POST" });
  }

  return (
    <main>
      <nav className="nav" aria-label="Main navigation">
        <a className="brand" href="#" aria-label="Keepsake home">
          <span className="brand-mark"><InstagramIcon /></span>
          keepsake
        </a>
        <span className="local-badge"><span /> Running locally</span>
      </nav>

      <section className="hero local-hero">
        <div className="eyebrow"><span className="eyebrow-icon">✦</span>INSTAGRAM HIGHLIGHT ARCHIVER</div>
        <h1>One profile.<br /><em>Every highlight.</em></h1>
        <p className="intro">
          See highlights exactly as they’re organized on Instagram, then save
          every story into clean, named folders on your computer.
        </p>

        <form className="username-form" onSubmit={handleScan}>
          <div className="username-field">
            <label htmlFor="target">Instagram profile link</label>
            <div className="username-input">
              <span>↗</span>
              <input
                id="target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="https://www.instagram.com/natgeo/"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="session-field">
            <label htmlFor="session">Connected as</label>
            <div className="session-row">
              <select
                id="session"
                value={viewer}
                onChange={(event) => setViewer(event.target.value)}
              >
                <option value="">Choose a session</option>
                {sessions.map((session) => (
                  <option key={session} value={session}>@{session}</option>
                ))}
              </select>
              <button type="button" className="refresh-button" onClick={refreshStatus}>
                Refresh
              </button>
            </div>
          </div>
          <button className="scan-button" type="submit" disabled={!target || !viewer || status === "scanning"}>
            {status === "scanning" ? "Finding highlights…" : "Show highlights"}
            {status !== "scanning" && <span>→</span>}
          </button>
        </form>

        <div className="connect-line">
          <span>Instagram requires a viewer session, even for public highlights.</span>
          <button type="button" onClick={() => setLoginOpen(true)}>Connect another account</button>
        </div>

        {message && (
          <div className={`status-card ${status === "error" ? "error-card" : "info-card"}`} role="status">
            <span>{status === "error" ? "!" : "i"}</span>
            <p>{message}</p>
          </div>
        )}
      </section>

      {scan && (
        <section className="library">
          <div className="profile-row">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={scan.profile.profile_pic_url} alt="" className="profile-photo" />
            <div>
              <span className="result-owner">@{scan.profile.username}</span>
              <h2>{scan.profile.full_name || scan.profile.username}</h2>
              <p>{scan.highlights.length} highlights · {scan.highlights.reduce((sum, item) => sum + item.item_count, 0)} stories</p>
            </div>
            <span className="profile-ready">Ready to browse</span>
          </div>

          {scan.highlights.length ? (
            <div className="highlight-strip">
              {scan.highlights.map((highlight) => (
                <button
                  type="button"
                  className={`highlight-card ${activeHighlight?.id === highlight.id ? "selected" : ""}`}
                  key={highlight.id}
                  onClick={() => loadStories(highlight)}
                  aria-pressed={activeHighlight?.id === highlight.id}
                >
                  <span className="highlight-ring">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={highlight.cover_url} alt="" />
                    <i>{activeHighlight?.id === highlight.id ? "●" : ""}</i>
                  </span>
                  <strong>{highlight.title}</strong>
                  <small>{highlight.item_count} stories</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-highlights">This profile has no visible highlights.</div>
          )}

          {activeHighlight && (
            <div className="story-browser">
              <div className="story-browser-head">
                <div>
                  <span className="result-owner">SELECTED HIGHLIGHT</span>
                  <h3>{activeHighlight.title}</h3>
                  <p>{activeHighlight.item_count} stories in Instagram order</p>
                </div>
                <span className="order-note">1 → {activeHighlight.item_count}</span>
              </div>

              {storiesLoading ? (
                <div className="stories-loading">
                  <span className="loader" />
                  Loading stories…
                </div>
              ) : (
                <div className="story-grid">
                  {stories.map((story) => (
                    <article className="story-card" key={story.id}>
                      <div className="story-media">
                        {story.type === "video" ? (
                          <video
                            src={story.preview_url}
                            controls
                            preload="metadata"
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={story.preview_url} alt={`${activeHighlight.title} story ${story.position}`} />
                        )}
                        <span className="story-number">{story.position}</span>
                        <span className="story-type">{story.type}</span>
                      </div>
                      <div className="story-card-foot">
                        <span>{story.filename}</span>
                        <a href={story.download_url} download={story.filename}>
                          Download <b>↓</b>
                        </a>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="folder-preview">
            <div className="folder-tree">
              <span className="folder-icon"><FolderIcon /></span>
              <div>
                <strong>{scan.profile.username}/</strong>
                <p>
                  {scan.highlights.length} highlight folders · 1, 2, 3, …
                </p>
              </div>
            </div>
            <button type="button" onClick={startDownload} disabled={!scan.highlights.length || job?.status === "downloading"}>
              Download all as ZIP
              <span>⇩</span>
            </button>
          </div>
        </section>
      )}

      {job && (
        <section className={`download-job ${job.status}`}>
          <div className="job-top">
            <div>
              <span className="section-number">
                {job.status === "complete" ? "ARCHIVE COMPLETE" : "BUILDING YOUR ARCHIVE"}
              </span>
              <h2>
                {job.status === "complete"
                  ? `Saved @${job.username}`
                  : job.status === "error"
                    ? "Download stopped"
                    : job.current_highlight || "Preparing highlights…"}
              </h2>
              <p>
                {job.status === "complete"
                  ? `${job.downloaded_items} stories are organized and ready.`
                  : job.status === "error"
                    ? job.error
                    : `Story ${job.current_story || "—"} of ${job.current_story_total || "—"} · ${job.downloaded_items} of ${job.total_items} total`}
              </p>
            </div>
            {job.status === "complete" && (
              <div className="job-actions">
                <a href={`${API}/jobs/${job.id}/archive`} download={job.archive_name}>
                  <span>⇩</span> Download ZIP
                </a>
                <button type="button" onClick={openDownloads}><FolderIcon /> Open folder</button>
              </div>
            )}
          </div>
          {job.status !== "error" && (
            <div className="progress-track"><span style={{ width: `${job.status === "complete" ? 100 : progress}%` }} /></div>
          )}
          {job.output_path && <code>{job.output_path}</code>}
        </section>
      )}

      <section className="structure-section">
        <div>
          <span className="section-number">THE OUTPUT</span>
          <h2>Your archive,<br />already organized.</h2>
          <p>Highlight names and story order are preserved, with safe filenames for Windows.</p>
        </div>
        <pre aria-label="Example folder structure">{`downloads/
└── username/
    ├── Travel/
    │   ├── 1.jpg
    │   ├── 2.mp4
    │   └── 3.jpg
    └── Behind the scenes/
        ├── 1.mp4
        └── 2.jpg`}</pre>
      </section>

      {loginOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setLoginOpen(false)}>
          <div className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title" onMouseDown={(event) => event.stopPropagation()}>
            <span className="modal-kicker">LOCAL SESSION</span>
            <h2 id="login-title">Connect Instagram</h2>
            <p>A separate terminal will ask Instagram for your password and any 2FA code. Keepsake never receives or stores your password.</p>
            <label htmlFor="login-username">Your Instagram username</label>
            <div className="username-input">
              <span>@</span>
              <input
                id="login-username"
                value={loginName}
                onChange={(event) => setLoginName(event.target.value.replace(/^@/, ""))}
                placeholder="your_account"
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="cancel" onClick={() => setLoginOpen(false)}>Cancel</button>
              <button type="button" className="connect" onClick={connectSession} disabled={!loginName}>Open secure login</button>
            </div>
          </div>
        </div>
      )}

      <footer>
        <a className="brand footer-brand" href="#"><span className="brand-mark"><InstagramIcon /></span>keepsake</a>
        <p>For personal use and content you have permission to save.</p>
        <span>{downloadRoot ? `Saving to ${downloadRoot}` : "Local-first by design"}</span>
      </footer>
    </main>
  );
}
