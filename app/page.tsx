"use client";

import { FormEvent, useMemo, useState } from "react";

type MediaItem = {
  id: string;
  type: "image" | "video";
  url: string;
  thumbnail: string;
};

type HighlightResult = {
  title: string;
  owner: string;
  items: MediaItem[];
};

const sampleUrl = "https://www.instagram.com/stories/highlights/123456789/";

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" />
    </svg>
  );
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
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<HighlightResult | null>(null);

  const valid = useMemo(() => {
    try {
      const parsed = new URL(url);
      return (
        (parsed.hostname === "instagram.com" ||
          parsed.hostname === "www.instagram.com") &&
        parsed.pathname.includes("/stories/highlights/")
      );
    } catch {
      return false;
    }
  }, [url]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    setResult(null);

    if (!valid) {
      setStatus("error");
      setMessage("Paste a full Instagram highlight link to continue.");
      return;
    }

    setStatus("loading");

    try {
      const response = await fetch("/api/highlights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "We couldn’t read that highlight.");
      }

      setResult(data);
      setStatus("success");
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again.",
      );
    }
  }

  function downloadLink(item: MediaItem, index: number) {
    const extension = item.type === "video" ? "mp4" : "jpg";
    return `/api/download?url=${encodeURIComponent(item.url)}&name=keepsake-${index + 1}.${extension}`;
  }

  return (
    <main>
      <nav className="nav" aria-label="Main navigation">
        <a className="brand" href="#" aria-label="Keepsake home">
          <span className="brand-mark"><InstagramIcon /></span>
          keepsake
        </a>
        <span className="privacy"><span /> No sign-in required</span>
      </nav>

      <section className="hero">
        <div className="eyebrow">
          <span className="eyebrow-icon">✦</span>
          SAVE THE MOMENTS THAT MATTER
        </div>
        <h1>Keep their stories.<br /><em>Forever.</em></h1>
        <p className="intro">
          Download public Instagram highlight stories in their original quality.
          Fast, private, and beautifully simple.
        </p>

        <form className="download-form" onSubmit={handleSubmit}>
          <label htmlFor="highlight-url">Instagram highlight link</label>
          <div className={`input-shell ${status === "error" ? "has-error" : ""}`}>
            <span className="input-icon"><InstagramIcon /></span>
            <input
              id="highlight-url"
              type="url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                if (status === "error") setStatus("idle");
              }}
              placeholder={sampleUrl}
              autoComplete="url"
              spellCheck={false}
            />
            <button type="submit" disabled={status === "loading"}>
              {status === "loading" ? "Finding stories…" : "Find stories"}
              {status !== "loading" && <span aria-hidden="true">→</span>}
            </button>
          </div>
          <div className="form-meta">
            <span>Works with public highlights</span>
            <span className="meta-divider" />
            <span>Nothing is stored</span>
          </div>
        </form>

        {status === "loading" && (
          <div className="status-card loading-card" role="status">
            <span className="loader" />
            <div>
              <strong>Opening the highlight…</strong>
              <p>Gathering every available photo and video.</p>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="status-card error-card" role="alert">
            <span>!</span>
            <div>
              <strong>We couldn’t fetch this highlight</strong>
              <p>{message}</p>
            </div>
          </div>
        )}
      </section>

      {result && (
        <section className="results" aria-live="polite">
          <div className="results-head">
            <div>
              <span className="result-owner">@{result.owner}</span>
              <h2>{result.title}</h2>
              <p>{result.items.length} {result.items.length === 1 ? "story" : "stories"} ready to save</p>
            </div>
            <a
              className="download-all"
              href={downloadLink(result.items[0], 0)}
              download
            >
              <DownloadIcon /> Download first
            </a>
          </div>
          <div className="media-grid">
            {result.items.map((item, index) => (
              <article className="media-card" key={item.id}>
                <div className="media-frame">
                  {item.type === "video" ? (
                    <video src={item.url} poster={item.thumbnail} controls preload="metadata" />
                  ) : (
                    // Remote Instagram media must remain unoptimized and short-lived.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.url} alt={`Highlight story ${index + 1}`} />
                  )}
                  <span className="type-pill">{item.type}</span>
                </div>
                <div className="media-actions">
                  <span>Story {String(index + 1).padStart(2, "0")}</span>
                  <a href={downloadLink(item, index)} download>
                    <DownloadIcon /> Save
                  </a>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="how">
        <div className="how-copy">
          <span className="section-number">01 — 03</span>
          <h2>Three small steps.<br />One lasting memory.</h2>
        </div>
        <ol className="steps">
          <li>
            <span>01</span>
            <div><strong>Copy the link</strong><p>Open a public highlight on Instagram and copy its link.</p></div>
          </li>
          <li>
            <span>02</span>
            <div><strong>Paste it above</strong><p>We’ll find every available photo and video inside.</p></div>
          </li>
          <li>
            <span>03</span>
            <div><strong>Save your favorites</strong><p>Preview each story, then download the moments you want.</p></div>
          </li>
        </ol>
      </section>

      <footer>
        <a className="brand footer-brand" href="#"><span className="brand-mark"><InstagramIcon /></span>keepsake</a>
        <p>For personal use and public content only. Please respect creators’ rights.</p>
        <span>Made for memories <b>♥</b></span>
      </footer>
    </main>
  );
}
