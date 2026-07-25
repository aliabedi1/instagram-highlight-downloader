import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

function isAllowedMediaUrl(url: URL) {
  return (
    url.protocol === "https:" &&
    (url.hostname.endsWith(".cdninstagram.com") ||
      url.hostname.endsWith(".fbcdn.net"))
  );
}

export async function GET(request: NextRequest) {
  try {
    const mediaUrl = new URL(request.nextUrl.searchParams.get("url") || "");
    if (!isAllowedMediaUrl(mediaUrl)) {
      return NextResponse.json({ error: "Unsupported media source." }, { status: 400 });
    }

    const response = await fetch(mediaUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
    });

    if (!response.ok || !response.body) {
      return NextResponse.json({ error: "This story is no longer available." }, { status: 404 });
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
      return NextResponse.json({ error: "The source did not return a media file." }, { status: 415 });
    }

    const requestedName = request.nextUrl.searchParams.get("name") || "keepsake-story";
    const safeName = requestedName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);

    return new NextResponse(response.body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${safeName}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "Invalid media link." }, { status: 400 });
  }
}
