import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const MAX_PAGE_BYTES = 5_000_000;

function decodeMediaUrl(value: string) {
  return value
    .replace(/\\u0026/g, "&")
    .replace(/\\u0025/g, "%")
    .replace(/\\u003d/g, "=")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function isInstagramMedia(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname.endsWith(".cdninstagram.com") ||
        parsed.hostname.endsWith(".fbcdn.net"))
    );
  } catch {
    return false;
  }
}

function collectMatches(html: string, pattern: RegExp, target: Set<string>) {
  for (const match of html.matchAll(pattern)) {
    const candidate = decodeMediaUrl(match[1]);
    if (isInstagramMedia(candidate)) target.add(candidate);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { url?: string };
    if (!body.url) {
      return NextResponse.json({ error: "A highlight link is required." }, { status: 400 });
    }

    const target = new URL(body.url);
    const validHost =
      target.hostname === "instagram.com" || target.hostname === "www.instagram.com";
    const validPath = /^\/stories\/highlights\/\d+\/?$/.test(target.pathname);

    if (target.protocol !== "https:" || !validHost || !validPath) {
      return NextResponse.json(
        { error: "This doesn’t look like a public Instagram highlight link." },
        { status: 400 },
      );
    }

    const response = await fetch(target.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Instagram didn’t make this highlight available. Check that it is public and still active." },
        { status: 422 },
      );
    }

    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_PAGE_BYTES) {
      return NextResponse.json({ error: "This highlight is too large to process." }, { status: 413 });
    }

    const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
    const videos = new Set<string>();
    const images = new Set<string>();

    collectMatches(html, /"video_url"\s*:\s*"([^"]+)"/g, videos);
    collectMatches(html, /property="og:video(?::secure_url)?"\s+content="([^"]+)"/g, videos);
    collectMatches(html, /"display_url"\s*:\s*"([^"]+)"/g, images);
    collectMatches(html, /property="og:image"\s+content="([^"]+)"/g, images);

    for (const video of videos) images.delete(video);

    const titleMatch =
      html.match(/property="og:title"\s+content="([^"]+)"/) ||
      html.match(/<title>([^<]+)<\/title>/);
    const rawTitle = titleMatch?.[1]?.replace(/&amp;/g, "&") || "Instagram highlight";
    const ownerMatch = rawTitle.match(/@([A-Za-z0-9._]+)/);
    const owner = ownerMatch?.[1] || "instagram";

    const items = [
      ...Array.from(videos).map((url, index) => ({
        id: `video-${index}`,
        type: "video" as const,
        url,
        thumbnail: Array.from(images)[index] || "",
      })),
      ...Array.from(images).map((url, index) => ({
        id: `image-${index}`,
        type: "image" as const,
        url,
        thumbnail: url,
      })),
    ].slice(0, 100);

    if (!items.length) {
      return NextResponse.json(
        {
          error:
            "No downloadable stories were exposed by Instagram. The highlight may be private, expired, age-restricted, or temporarily rate-limited.",
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      title: rawTitle.split(" • ")[0].slice(0, 80),
      owner,
      items,
    });
  } catch {
    return NextResponse.json(
      { error: "That link couldn’t be processed. Please copy it again from Instagram." },
      { status: 400 },
    );
  }
}
