"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

const API = "http://127.0.0.1:8787/api";
const SESSION_KEY = "keepsake-browser-session";
const HIGHLIGHTS_PER_PAGE = 20;

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
  total_highlights: number;
  total_stories: number;
};

type Story = {
  id: string;
  position: number;
  type: "image" | "video";
  filename: string;
  source_url: string;
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
  archive_name?: string;
  error?: string;
};

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

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
  const timeout = window.setTimeout(() => controller.abort(), 90000);
  try {
    const sessionToken = window.sessionStorage.getItem(SESSION_KEY);
    const headers = new Headers(options?.headers);
    if (options?.body) headers.set("Content-Type", "application/json");
    if (sessionToken) headers.set("X-Keepsake-Session", sessionToken);
    const response = await fetch(`${API}${path}`, {
      ...options,
      signal: options?.signal || controller.signal,
      headers,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new ApiError(data.detail || "Something went wrong.", response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        "Instagram did not respond within 90 seconds. The request was stopped; wait before trying again.",
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
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<Highlight | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [storiesLoading, setStoriesLoading] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [status, setStatus] = useState<"idle" | "scanning" | "error">("idle");
  const [message, setMessage] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [highlightPage, setHighlightPage] = useState(1);

  const totalHighlightPages = scan
    ? Math.ceil(scan.total_highlights / HIGHLIGHTS_PER_PAGE)
    : 0;
  const firstVisibleHighlight = (highlightPage - 1) * HIGHLIGHTS_PER_PAGE;
  const visibleHighlights = scan?.highlights.slice(
    firstVisibleHighlight,
    firstVisibleHighlight + HIGHLIGHTS_PER_PAGE,
  ) ?? [];

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api<{ connected: boolean; username: string | null }>("/status");
      setViewer(data.connected ? data.username || "" : "");
      if (!data.connected) window.sessionStorage.removeItem(SESSION_KEY);
      setMessage("");
    } catch {
      setMessage("The local download service is not running. Start the app with start-local.ps1.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(refreshStatus, 0);
    return () => window.clearTimeout(timer);
  }, [refreshStatus]);

  useEffect(() => {
    if (!viewer) return;
    const heartbeat = () => api("/session/heartbeat", { method: "POST" }).catch(() => setViewer(""));
    const timer = window.setInterval(heartbeat, 45_000);
    return () => window.clearInterval(timer);
  }, [viewer]);

  async function handleScan(event: FormEvent) {
    event.preventDefault();
    setStatus("scanning");
    setMessage("");
    setScan(null);
    setJob(null);
    setHighlightPage(1);
    setActiveHighlight(null);
    setStories([]);
    try {
      const data = await api<ScanResult>("/highlights/scan", {
        method: "POST",
        body: JSON.stringify({
          target_username: target,
        }),
      });
      setScan(data);
      setStatus("idle");
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
          highlight_id: highlight.id,
        }),
      });
      setActiveHighlight(data.highlight);
      setScan((current) => {
        if (!current) return current;
        const previous = current.highlights.find((item) => item.id === data.highlight.id);
        if (!previous) return current;
        return {
          ...current,
          total_stories: current.total_stories - previous.item_count + data.highlight.item_count,
          highlights: current.highlights.map((item) => (
            item.id === data.highlight.id ? data.highlight : item
          )),
        };
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
    setLoginLoading(true);
    setMessage("");
    try {
      const data = await api<{ session_token: string; username: string }>("/session/login", {
        method: "POST",
        body: JSON.stringify({
          username: loginName,
          password: loginPassword,
          verification_code: verificationCode,
        }),
      });
      window.sessionStorage.setItem(SESSION_KEY, data.session_token);
      setViewer(data.username);
      setLoginPassword("");
      setVerificationCode("");
      setNeedsTwoFactor(false);
      setMessage(`Connected as @${data.username}. Login data stays in memory only while this tab is active.`);
      setLoginOpen(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setNeedsTwoFactor(true);
      }
      setMessage(error instanceof Error ? error.message : "Could not open login.");
    } finally {
      setLoginLoading(false);
    }
  }

  function changeHighlightPage(page: number) {
    setHighlightPage(page);
    setActiveHighlight(null);
    setStories([]);
  }

  function closeLogin() {
    setLoginOpen(false);
    setLoginPassword("");
    setVerificationCode("");
    setNeedsTwoFactor(false);
  }

  async function disconnectSession() {
    try {
      await api("/session", { method: "DELETE" });
    } finally {
      window.sessionStorage.removeItem(SESSION_KEY);
      setViewer("");
      setScan(null);
      setJob(null);
      setMessage("Instagram session removed from memory.");
    }
  }

  async function startDownload(highlightTitles: string[] | null = null) {
    if (!scan) return;
    setMessage("");
    try {
      const data = await api<{ job_id: string }>("/highlights/download", {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          highlight_titles: highlightTitles,
        }),
      });
      const ready = await api<Job>(`/jobs/${data.job_id}`);
      setJob(ready);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Download could not start.");
    }
  }

  return (
    <main>
      <nav className="nav" aria-label="Main navigation">
        <a className="brand" href="#" aria-label="Keepsake home">
          <span className="brand-mark"><InstagramIcon /></span>
          keepsake
        </a>
        <span className="local-badge"><span /> {viewer ? `Connected @${viewer}` : "Login required"}</span>
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
            <label>Instagram session</label>
            {viewer ? (
              <div className="connected-account">
                <span>●</span>
                <strong>@{viewer}</strong>
              </div>
            ) : (
              <button type="button" className="login-inline" onClick={() => setLoginOpen(true)}>
                Connect Instagram
              </button>
            )}
          </div>
          <button className="scan-button" type="submit" disabled={!target || !viewer || status === "scanning"}>
            {status === "scanning" ? "Finding highlights…" : "Show highlights"}
            {status !== "scanning" && <span>→</span>}
          </button>
        </form>

        <div className="connect-line">
          <span>Your Instagram login exists only in memory while this tab stays active.</span>
          {viewer ? (
            <button type="button" onClick={disconnectSession}>Disconnect</button>
          ) : (
            <button type="button" onClick={() => setLoginOpen(true)}>Connect account</button>
          )}
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
            <img
              src={scan.profile.profile_pic_url}
              alt=""
              className="profile-photo"
              referrerPolicy="no-referrer"
            />
            <div>
              <span className="result-owner">@{scan.profile.username}</span>
              <h2>{scan.profile.full_name || scan.profile.username}</h2>
              <p>{scan.total_highlights} highlights · {scan.total_stories} stories</p>
            </div>
            <span className="profile-ready">Ready to browse</span>
          </div>

          {scan.highlights.length ? (
            <>
              {!activeHighlight && (
                <p className="highlight-tip">
                  <span aria-hidden="true">↓</span>
                  <strong>Choose a highlight</strong> to preview its stories
                </p>
              )}
              <div className="highlight-strip">
                {visibleHighlights.map((highlight) => (
                  <button
                    type="button"
                    className={`highlight-card ${activeHighlight?.id === highlight.id ? "selected" : ""}`}
                    key={highlight.id}
                    onClick={() => loadStories(highlight)}
                    aria-pressed={activeHighlight?.id === highlight.id}
                  >
                    <span className="highlight-ring">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={highlight.cover_url}
                        alt=""
                        referrerPolicy="no-referrer"
                      />
                      <i>{activeHighlight?.id === highlight.id ? "●" : ""}</i>
                    </span>
                    <strong>{highlight.title}</strong>
                    <small>{highlight.item_count} stories</small>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-highlights">This profile has no visible highlights.</div>
          )}

          {totalHighlightPages > 1 && (
            <nav className="highlight-pagination" aria-label="Highlight pages">
              <button
                type="button"
                onClick={() => changeHighlightPage(highlightPage - 1)}
                disabled={highlightPage === 1}
              >
                Previous
              </button>
              <div className="highlight-pages">
                {Array.from({ length: totalHighlightPages }, (_, index) => index + 1).map((page) => (
                  <button
                    type="button"
                    className={page === highlightPage ? "active" : ""}
                    key={page}
                    onClick={() => changeHighlightPage(page)}
                    aria-label={`Page ${page}`}
                    aria-current={page === highlightPage ? "page" : undefined}
                  >
                    {page}
                  </button>
                ))}
              </div>
              <span>
                {firstVisibleHighlight + 1}–{Math.min(firstVisibleHighlight + HIGHLIGHTS_PER_PAGE, scan.total_highlights)} of {scan.total_highlights}
              </span>
              <button
                type="button"
                onClick={() => changeHighlightPage(highlightPage + 1)}
                disabled={highlightPage === totalHighlightPages}
              >
                Next
              </button>
            </nav>
          )}

          {activeHighlight && (
            <div className="story-browser">
              <div className="story-browser-head">
                <div>
                  <span className="result-owner">SELECTED HIGHLIGHT</span>
                  <h3>{activeHighlight.title}</h3>
                  <p>{activeHighlight.item_count} stories in Instagram order</p>
                </div>
                <div className="story-browser-actions">
                  <span className="order-note">1 → {activeHighlight.item_count}</span>
                  <button
                    type="button"
                    onClick={() => startDownload([activeHighlight.title])}
                  >
                    Download highlight <span>⇩</span>
                  </button>
                </div>
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
                            src={story.source_url}
                            controls
                            preload="metadata"
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={story.source_url}
                            alt={`${activeHighlight.title} story ${story.position}`}
                            referrerPolicy="no-referrer"
                          />
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
                  {scan.total_highlights} highlight folders · 1, 2, 3, …
                </p>
              </div>
            </div>
            <button type="button" onClick={() => startDownload()} disabled={!scan.highlights.length || job?.status === "downloading"}>
              Prepare browser download
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
                  ? `Ready for @${job.username}`
                  : job.status === "error"
                    ? "Download stopped"
                    : job.current_highlight || "Preparing highlights…"}
              </h2>
              <p>
                {job.status === "complete"
                  ? `${job.downloaded_items} stories will stream straight to your browser as a ZIP.`
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
              </div>
            )}
          </div>
          {job.status !== "error" && (
            <div className="progress-track"><span style={{ width: `${job.status === "complete" ? 100 : 0}%` }} /></div>
          )}
        </section>
      )}

      <section className="structure-section">
        <div>
          <span className="section-number">THE OUTPUT</span>
          <h2>Your archive,<br />already organized.</h2>
          <p>Highlight names and story order are preserved inside the browser download. Nothing is kept in a server download folder.</p>
        </div>
        <pre aria-label="Example ZIP structure">{`username-highlights.zip
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
        <div className="modal-backdrop" role="presentation" onMouseDown={closeLogin}>
          <div className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title" onMouseDown={(event) => event.stopPropagation()}>
            <span className="modal-kicker">LOCAL SESSION</span>
            <h2 id="login-title">Connect Instagram</h2>
            <p>Your credentials are sent only to the local backend to create an Instagram session. The password is discarded after login; session data remains in memory until you disconnect, close this tab, or it becomes inactive.</p>
            <label htmlFor="login-username">Your Instagram username</label>
            <div className="username-input">
              <span>@</span>
              <input
                id="login-username"
                value={loginName}
                onChange={(event) => setLoginName(event.target.value.replace(/^@/, ""))}
                placeholder="your_account"
                autoFocus
                autoComplete="username"
              />
            </div>
            <label htmlFor="login-password">Instagram password</label>
            <div className="username-input">
              <span>⌁</span>
              <input
                id="login-password"
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                placeholder="Your password"
                autoComplete="current-password"
              />
            </div>
            {needsTwoFactor && (
              <>
                <label htmlFor="verification-code">Two-factor code</label>
                <div className="username-input">
                  <span>#</span>
                  <input
                    id="verification-code"
                    inputMode="numeric"
                    value={verificationCode}
                    onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                    placeholder="6-digit code or 8-digit backup code"
                    autoComplete="one-time-code"
                  />
                </div>
              </>
            )}
            <div className="modal-actions">
              <button type="button" className="cancel" onClick={closeLogin}>Cancel</button>
              <button
                type="button"
                className="connect"
                onClick={connectSession}
                disabled={!loginName || !loginPassword || loginLoading || (needsTwoFactor && !verificationCode)}
              >
                {loginLoading ? "Connecting…" : "Connect"}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer>
        <a className="brand footer-brand" href="#"><span className="brand-mark"><InstagramIcon /></span>keepsake</a>
        <p>For personal use and content you have permission to save.</p>
        <span>Browser download · no server archive</span>
      </footer>
    </main>
  );
}
