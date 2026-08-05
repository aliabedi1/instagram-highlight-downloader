"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import ThemeSelector from "./theme-selector";

const API = "http://127.0.0.1:8787/api";
const SESSION_KEY = "keepsake-browser-session";

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
  page: number;
  page_size: number;
  total_pages: number;
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

type DownloadJob = {
  status: "preparing" | "complete" | "error";
  completed_highlights: number;
  total_highlights: number;
  current_highlight: string;
  error: string;
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
  const [downloadTarget, setDownloadTarget] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState("");
  const [downloadError, setDownloadError] = useState<{ target: string; message: string } | null>(null);
  const [status, setStatus] = useState<"idle" | "scanning" | "error">("idle");
  const [message, setMessage] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [highlightPage, setHighlightPage] = useState(1);
  const [highlightPageLoading, setHighlightPageLoading] = useState(false);

  const totalHighlightPages = scan?.total_pages ?? 0;
  const firstVisibleHighlight = scan
    ? (scan.page - 1) * scan.page_size
    : 0;
  const visibleHighlights = scan?.highlights ?? [];
  const visiblePageNumbers = totalHighlightPages <= 7
    ? Array.from({ length: totalHighlightPages }, (_, index) => index + 1)
    : Array.from(new Set([
        1,
        Math.max(2, highlightPage - 1),
        highlightPage,
        Math.min(totalHighlightPages - 1, highlightPage + 1),
        totalHighlightPages,
      ])).sort((first, second) => first - second);

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
    setDownloadTarget(null);
    setDownloadError(null);
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
      setHighlightPage(data.page);
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

  async function connectSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = loginName.trim();
    const code = verificationCode.trim();

    if (loginLoading || !username || !loginPassword) return;
    if (needsTwoFactor && !/^(?:\d{6}|\d{8})$/.test(code)) return;

    setLoginLoading(true);
    setMessage("");
    try {
      const data = await api<{ session_token: string; username: string }>("/session/login", {
        method: "POST",
        body: JSON.stringify({
          username,
          password: loginPassword,
          verification_code: code,
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

  async function changeHighlightPage(page: number) {
    if (
      !scan
      || highlightPageLoading
      || page === highlightPage
      || page < 1
      || page > totalHighlightPages
    ) return;

    setHighlightPageLoading(true);
    setMessage("");
    setActiveHighlight(null);
    setStories([]);
    try {
      const data = await api<ScanResult>("/highlights/page", {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          page,
        }),
      });
      setScan(data);
      setHighlightPage(data.page);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not load that highlight page.",
      );
    } finally {
      setHighlightPageLoading(false);
    }
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
      setDownloadTarget(null);
      setDownloadError(null);
      setMessage("Instagram session removed from memory.");
    }
  }

  async function startDownload(highlightTitles: string[] | null = null) {
    if (!scan || downloadTarget) return;
    const requestedTarget = highlightTitles?.[0]
      ? `highlight:${highlightTitles[0]}`
      : "all";

    setDownloadTarget(requestedTarget);
    setDownloadProgress("Preparing download…");
    setDownloadError(null);
    setMessage("");
    try {
      const data = await api<{ job_id: string }>("/highlights/download", {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          highlight_titles: highlightTitles,
        }),
      });
      let job: DownloadJob;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        job = await api<DownloadJob>(`/jobs/${data.job_id}`);
        if (job.status === "error") {
          throw new Error(job.error || "Download could not be prepared.");
        }
        if (job.status === "preparing") {
          setDownloadProgress(
            job.total_highlights > 1
              ? `Preparing ${job.completed_highlights} of ${job.total_highlights} highlights…`
              : "Preparing highlight…",
          );
        }
      } while (job.status !== "complete");

      const downloadLink = document.createElement("a");
      downloadLink.href = `${API}/jobs/${data.job_id}/archive`;
      downloadLink.download = "";
      downloadLink.hidden = true;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
    } catch (error) {
      setDownloadError({
        target: requestedTarget,
        message: error instanceof Error ? error.message : "Download could not start.",
      });
    } finally {
      setDownloadTarget(null);
      setDownloadProgress("");
    }
  }

  return (
    <main>
      <nav className="nav" aria-label="Main navigation">
        <a className="brand" href="#" aria-label="Keepsake home">
          <span className="brand-mark"><InstagramIcon /></span>
          keepsake
        </a>
        <div className="nav-actions">
          <ThemeSelector />
          <span className="local-badge"><span /> {viewer ? `Connected @${viewer}` : "Login required"}</span>
        </div>
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
            <div className="profile-download-control">
              <button
                type="button"
                onClick={() => startDownload()}
                disabled={!scan.total_highlights || downloadTarget !== null}
                aria-busy={downloadTarget === "all"}
              >
                {downloadTarget === "all" ? (
                  <><span className="button-spinner" /> {downloadProgress}</>
                ) : (
                  <>Download all highlights <span aria-hidden="true">⇩</span></>
                )}
              </button>
              {downloadError?.target === "all" && (
                <p className="download-error" role="alert">{downloadError.message}</p>
              )}
            </div>
          </div>

          {scan.highlights.length ? (
            <>
              {!activeHighlight && (
                <p className="highlight-tip">
                  <span aria-hidden="true">↓</span>
                  <strong>Choose a highlight</strong> to preview its stories
                </p>
              )}
              <div className="highlight-strip" aria-busy={highlightPageLoading}>
                {highlightPageLoading ? (
                  <div className="highlight-page-loading" role="status">
                    <span className="loader" />
                    Loading highlight page…
                  </div>
                ) : visibleHighlights.map((highlight) => (
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
                          loading="lazy"
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
                disabled={highlightPageLoading || highlightPage === 1}
              >
                Previous
              </button>
              <div className="highlight-pages">
                {visiblePageNumbers.map((page, index) => (
                  <span className="highlight-page-control" key={page}>
                    {index > 0 && page - visiblePageNumbers[index - 1] > 1 && (
                      <span className="page-ellipsis" aria-hidden="true">…</span>
                    )}
                    <button
                      type="button"
                      className={page === highlightPage ? "active" : ""}
                      onClick={() => changeHighlightPage(page)}
                      disabled={highlightPageLoading}
                      aria-label={`Page ${page}`}
                      aria-current={page === highlightPage ? "page" : undefined}
                    >
                      {page}
                    </button>
                  </span>
                ))}
              </div>
              <span>
                {firstVisibleHighlight + 1}–{Math.min(firstVisibleHighlight + scan.page_size, scan.total_highlights)} of {scan.total_highlights}
              </span>
              <button
                type="button"
                onClick={() => changeHighlightPage(highlightPage + 1)}
                disabled={highlightPageLoading || highlightPage === totalHighlightPages}
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
                    disabled={downloadTarget !== null}
                    aria-busy={downloadTarget === `highlight:${activeHighlight.title}`}
                  >
                    {downloadTarget === `highlight:${activeHighlight.title}` ? (
                      <><span className="button-spinner" /> {downloadProgress}</>
                    ) : (
                      <>Download highlight <span>⇩</span></>
                    )}
                  </button>
                  {downloadError?.target === `highlight:${activeHighlight.title}` && (
                    <p className="download-error" role="alert">{downloadError.message}</p>
                  )}
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
          </div>
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
          <form className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title" onSubmit={connectSession} onMouseDown={(event) => event.stopPropagation()}>
            <span className="modal-kicker">LOCAL SESSION</span>
            <h2 id="login-title">Connect Instagram</h2>
            <p>Your credentials are sent only to the local backend to create an Instagram session. The password is discarded after login; session data remains in memory until you disconnect, close this tab, or it becomes inactive.</p>
            <label htmlFor="login-username">Your Instagram username</label>
            <div className="username-input">
              <span>@</span>
              <input
                id="login-username"
                name="username"
                value={loginName}
                onChange={(event) => setLoginName(event.target.value.replace(/^@/, ""))}
                placeholder="your_account"
                autoFocus
                autoComplete="username"
                required
              />
            </div>
            <label htmlFor="login-password">Instagram password</label>
            <div className="username-input">
              <span>⌁</span>
              <input
                id="login-password"
                name="password"
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                placeholder="Your password"
                autoComplete="current-password"
                required
              />
            </div>
            {needsTwoFactor && (
              <>
                <label htmlFor="verification-code">Two-factor code</label>
                <div className="username-input">
                  <span>#</span>
                  <input
                    id="verification-code"
                    name="verification-code"
                    inputMode="numeric"
                    value={verificationCode}
                    onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                    placeholder="6-digit code or 8-digit backup code"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}|[0-9]{8}"
                    autoFocus
                    required
                  />
                </div>
              </>
            )}
            <div className="modal-actions">
              <button type="button" className="cancel" onClick={closeLogin}>Cancel</button>
              <button
                type="submit"
                className="connect"
                disabled={!loginName.trim() || !loginPassword || loginLoading || (needsTwoFactor && !/^(?:\d{6}|\d{8})$/.test(verificationCode))}
              >
                {loginLoading ? "Connecting…" : "Connect"}
              </button>
            </div>
          </form>
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
