"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const API = "http://127.0.0.1:8787/api";
const REQUEST_TIMEOUT = 35_000;

type Highlight = {
  id: string;
  title: string;
  cover_url: string;
  item_count: number;
  position: number;
};

type Profile = {
  username: string;
  full_name: string;
  profile_pic_url: string;
  is_private: boolean;
  biography: string;
  posts: number;
  followers: number;
  following: number;
};

type ScanResult = {
  profile: Profile;
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
  highlight?: Highlight;
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

type Tab = "stories" | "highlights";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
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
        "Instagram is taking longer than expected. Wait a few minutes, then try again.",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
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

export default function Home() {
  const [target, setTarget] = useState("");
  const [viewer, setViewer] = useState("");
  const [serviceReady, setServiceReady] = useState<boolean | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [tab, setTab] = useState<Tab>("highlights");
  const [activeHighlight, setActiveHighlight] = useState<Highlight | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [storiesLoaded, setStoriesLoaded] = useState(false);
  const [loading, setLoading] = useState<"profile" | "stories" | "highlight" | "">("");
  const [message, setMessage] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginName, setLoginName] = useState("");

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api<{ sessions: string[] }>("/status");
      setServiceReady(true);
      setViewer((current) =>
        current && data.sessions.includes(current) ? current : data.sessions[0] || "",
      );
      return data.sessions;
    } catch {
      setServiceReady(false);
      return [];
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!job || !["queued", "downloading"].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        setJob(await api<Job>(`/jobs/${job.id}`));
      } catch (error) {
        setJob((current) =>
          current
            ? {
                ...current,
                status: "error",
                error: error instanceof Error ? error.message : "Download stopped.",
              }
            : null,
        );
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [job]);

  const progress = useMemo(() => {
    if (!job?.total_items) return 0;
    return Math.min(100, Math.round((job.downloaded_items / job.total_items) * 100));
  }, [job]);

  async function pasteLink() {
    try {
      setTarget(await navigator.clipboard.readText());
      setMessage("");
    } catch {
      setMessage("Clipboard access was blocked. Paste the Instagram link manually.");
    }
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    setScan(null);
    setStories([]);
    setStoriesLoaded(false);
    setActiveHighlight(null);
    setJob(null);

    if (!serviceReady) {
      setMessage("Start Keepsake on this computer first, then try again.");
      return;
    }
    if (!viewer) {
      setMessage("Connect an Instagram account once to view public stories and highlights.");
      setLoginOpen(true);
      return;
    }

    setLoading("profile");
    try {
      const result = await api<ScanResult>("/highlights/scan", {
        method: "POST",
        body: JSON.stringify({
          target_username: target,
          session_username: viewer,
        }),
      });
      setScan(result);
      setTab("highlights");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load that profile.");
    } finally {
      setLoading("");
    }
  }

  async function showStories() {
    if (!scan) return;
    setTab("stories");
    setActiveHighlight(null);
    setMessage("");
    if (storiesLoaded) return;

    setLoading("stories");
    try {
      const result = await api<StoryResult>("/stories/active", {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          session_username: viewer,
        }),
      });
      setStories(result.stories);
      setStoriesLoaded(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load stories.");
    } finally {
      setLoading("");
    }
  }

  function showHighlights() {
    setTab("highlights");
    setActiveHighlight(null);
    setStories([]);
    setMessage("");
  }

  async function openHighlight(highlight: Highlight) {
    if (!scan) return;
    setActiveHighlight(highlight);
    setStories([]);
    setMessage("");
    setLoading("highlight");
    try {
      const result = await api<StoryResult>("/highlights/stories", {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          session_username: viewer,
          highlight_id: highlight.id,
        }),
      });
      setStories(result.stories);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open that highlight.");
    } finally {
      setLoading("");
    }
  }

  async function connectSession() {
    setMessage("");
    try {
      const result = await api<{ message: string }>("/session/login", {
        method: "POST",
        body: JSON.stringify({ username: loginName }),
      });
      setMessage(result.message);
      setLoginOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open Instagram login.");
    }
  }

  async function startDownloadAll() {
    if (!scan) return;
    setMessage("");
    try {
      const result = await api<{ job_id: string }>("/highlights/download", {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          session_username: viewer,
          highlight_titles: null,
        }),
      });
      setJob({
        id: result.job_id,
        status: "queued",
        username: scan.profile.username,
        downloaded_items: 0,
        skipped_items: 0,
        total_items: scan.highlights.reduce((sum, item) => sum + item.item_count, 0),
        current_highlight: "",
        current_story: 0,
        current_story_total: 0,
      });
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
        <span className={`service-badge ${serviceReady ? "online" : "offline"}`}>
          <span />
          {serviceReady === null
            ? "Checking this computer"
            : serviceReady
              ? viewer
                ? `Connected as @${viewer}`
                : "Instagram not connected"
              : "Local service is off"}
        </span>
      </nav>

      <section className="hero">
        <div className="eyebrow">PRIVATE · LOCAL · NO WATERMARKS</div>
        <h1>Instagram stories,<br /><em>saved simply.</em></h1>
        <p className="intro">
          Paste a public Instagram profile link to browse its current stories
          and highlights, then download exactly what you need.
        </p>

        <form className="search-form" onSubmit={handleSearch}>
          <label htmlFor="instagram-link" className="sr-only">Instagram profile link</label>
          <div className="search-input">
            <span className="link-glyph">↗</span>
            <input
              id="instagram-link"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="https://www.instagram.com/username/"
              autoComplete="off"
              spellCheck={false}
            />
            {target ? (
              <button type="button" className="input-action" onClick={() => setTarget("")}>
                Clear
              </button>
            ) : (
              <button type="button" className="input-action" onClick={pasteLink}>
                Paste
              </button>
            )}
          </div>
          <button
            className="download-button"
            type="submit"
            disabled={!target.trim() || loading === "profile"}
          >
            {loading === "profile" ? "Finding profile…" : "Show stories"}
            {loading !== "profile" && <span>→</span>}
          </button>
        </form>

        <div className="helper-row">
          <span>Public profiles only. Use content you own or have permission to save.</span>
          {serviceReady ? (
            <button type="button" onClick={() => setLoginOpen(true)}>
              {viewer ? "Connect another account" : "Connect Instagram"}
            </button>
          ) : (
            <span className="start-hint">Run <b>start-local.ps1</b> on this computer</span>
          )}
        </div>

        {message && (
          <div className="notice" role="status">
            <span>!</span>
            <p>{message}</p>
            {serviceReady && (
              /rate-limit|temporarily/i.test(message) ? (
                <button type="button" onClick={() => setLoginOpen(true)}>
                  Use another account
                </button>
              ) : (
                <button type="button" onClick={refreshStatus}>Refresh connection</button>
              )
            )}
          </div>
        )}
      </section>

      {scan && (
        <section className="results" aria-live="polite">
          <header className="profile-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={scan.profile.profile_pic_url} alt="" className="profile-photo" />
            <div className="profile-copy">
              <span className="result-label">SEARCH RESULT</span>
              <h2>{scan.profile.full_name || scan.profile.username}</h2>
              <a
                href={`https://www.instagram.com/${scan.profile.username}/`}
                target="_blank"
                rel="noreferrer"
              >
                @{scan.profile.username} ↗
              </a>
              {scan.profile.biography && <p>{scan.profile.biography}</p>}
            </div>
            <dl className="profile-stats">
              <div><dt>{formatCount(scan.profile.posts)}</dt><dd>posts</dd></div>
              <div><dt>{formatCount(scan.profile.followers)}</dt><dd>followers</dd></div>
              <div><dt>{formatCount(scan.profile.following)}</dt><dd>following</dd></div>
            </dl>
          </header>

          <div className="result-tabs" role="tablist" aria-label="Profile media">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "stories"}
              className={tab === "stories" ? "active" : ""}
              onClick={showStories}
            >
              Stories
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "highlights"}
              className={tab === "highlights" ? "active" : ""}
              onClick={showHighlights}
            >
              Highlights <span>{scan.highlights.length}</span>
            </button>
          </div>

          {tab === "highlights" && !activeHighlight && (
            <>
              {scan.highlights.length ? (
                <div className="highlight-grid">
                  {scan.highlights.map((highlight) => (
                    <button
                      type="button"
                      className="highlight-tile"
                      key={highlight.id}
                      onClick={() => openHighlight(highlight)}
                    >
                      <span className="highlight-cover">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={highlight.cover_url} alt="" />
                      </span>
                      <strong>{highlight.title}</strong>
                      <small>{highlight.item_count} items</small>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  This profile has no visible highlights.
                </div>
              )}
              {!!scan.highlights.length && (
                <div className="bulk-row">
                  <div>
                    <strong>Save the complete collection</strong>
                    <span>Highlight names and story order are preserved in one ZIP.</span>
                  </div>
                  <button
                    type="button"
                    onClick={startDownloadAll}
                    disabled={job?.status === "queued" || job?.status === "downloading"}
                  >
                    Download all as ZIP ↓
                  </button>
                </div>
              )}
            </>
          )}

          {tab === "highlights" && activeHighlight && (
            <div className="media-panel">
              <div className="panel-heading">
                <button type="button" onClick={showHighlights}>← All highlights</button>
                <div>
                  <span>SELECTED HIGHLIGHT</span>
                  <h3>{activeHighlight.title}</h3>
                </div>
                <small>{activeHighlight.item_count} items</small>
              </div>
              <MediaGrid
                stories={stories}
                loading={loading === "highlight"}
                emptyText="This highlight has no available media."
              />
            </div>
          )}

          {tab === "stories" && (
            <div className="media-panel">
              <div className="panel-heading">
                <div>
                  <span>LAST 24 HOURS</span>
                  <h3>Current stories</h3>
                </div>
                {storiesLoaded && <small>{stories.length} items</small>}
              </div>
              <MediaGrid
                stories={stories}
                loading={loading === "stories"}
                emptyText="There are no current stories for this profile. Try again later."
              />
            </div>
          )}
        </section>
      )}

      {job && (
        <section className={`job-card ${job.status}`}>
          <div>
            <span>{job.status === "complete" ? "ARCHIVE READY" : "BUILDING ARCHIVE"}</span>
            <h2>
              {job.status === "error"
                ? "Download stopped"
                : job.status === "complete"
                  ? `@${job.username} is ready`
                  : job.current_highlight || "Preparing highlights…"}
            </h2>
            <p>
              {job.status === "error"
                ? job.error
                : `${job.downloaded_items} of ${job.total_items} stories prepared`}
            </p>
          </div>
          {job.status === "complete" && (
            <a href={`${API}/jobs/${job.id}/archive`} download={job.archive_name}>
              Download ZIP ↓
            </a>
          )}
          {job.status !== "error" && (
            <div className="progress"><span style={{ width: `${job.status === "complete" ? 100 : progress}%` }} /></div>
          )}
        </section>
      )}

      <section className="steps">
        <span className="result-label">HOW IT WORKS</span>
        <h2>Three small steps.</h2>
        <div>
          <article><b>01</b><h3>Paste a profile</h3><p>Copy the public Instagram profile URL and paste it above.</p></article>
          <article><b>02</b><h3>Choose media</h3><p>Open current stories or browse highlights in their original order.</p></article>
          <article><b>03</b><h3>Download</h3><p>Save one item or download every highlight as an organized ZIP.</p></article>
        </div>
      </section>

      {loginOpen && (
        <div className="modal-backdrop" onMouseDown={() => setLoginOpen(false)}>
          <div
            className="login-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="result-label">ONE-TIME LOCAL SETUP</span>
            <h2 id="login-title">Connect Instagram</h2>
            <p>
              Instagram requires a signed-in viewer even for public highlights.
              Your password is entered only in Instagram’s local login terminal.
            </p>
            <label htmlFor="login-username">Your Instagram username</label>
            <div className="modal-input">
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
              <button type="button" className="cancel" onClick={() => setLoginOpen(false)}>
                Cancel
              </button>
              <button type="button" onClick={connectSession} disabled={!loginName.trim()}>
                Open secure login
              </button>
            </div>
          </div>
        </div>
      )}

      <footer>
        <a className="brand" href="#"><span className="brand-mark"><InstagramIcon /></span>keepsake</a>
        <p>For personal use and content you have permission to save.</p>
        <span>Runs privately on your computer</span>
      </footer>
    </main>
  );
}

function MediaGrid({
  stories,
  loading,
  emptyText,
}: {
  stories: Story[];
  loading: boolean;
  emptyText: string;
}) {
  if (loading) {
    return <div className="loading-state"><span /> Loading Instagram media…</div>;
  }
  if (!stories.length) {
    return <div className="empty-state">{emptyText}</div>;
  }
  return (
    <div className="story-grid">
      {stories.map((story) => (
        <article className="story-card" key={story.id}>
          <div className="story-media">
            {story.type === "video" ? (
              <video src={story.preview_url} controls preload="metadata" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={story.preview_url} alt={`Instagram story ${story.position}`} />
            )}
            <span>{story.position}</span>
          </div>
          <div>
            <small>{story.type}</small>
            <a href={story.download_url} download={story.filename}>Download ↓</a>
          </div>
        </article>
      ))}
    </div>
  );
}
