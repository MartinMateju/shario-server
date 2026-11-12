const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const SHORT_YOUTUBE_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

const cleanVideoId = (value: unknown): string => {
  const videoId = String(value ?? "").trim();
  return YOUTUBE_VIDEO_ID_PATTERN.test(videoId) ? videoId : "";
};

/**
 * Accepts only a concrete HTTPS YouTube video URL. The caller stores the
 * canonical watch URL and builds embeds from the validated video id, so an
 * arbitrary user URL can never become an iframe source.
 */
export const getYouTubeVideoId = (value: unknown): string | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (SHORT_YOUTUBE_HOSTS.has(hostname)) {
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 1 ? cleanVideoId(parts[0]) || null : null;
  }
  if (!YOUTUBE_HOSTS.has(hostname)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/watch" || url.pathname === "/watch/") {
    return cleanVideoId(url.searchParams.get("v")) || null;
  }
  if (
    parts.length === 2 &&
    ["embed", "shorts", "live"].includes(parts[0] || "")
  ) {
    return cleanVideoId(parts[1]) || null;
  }
  return null;
};

export const normalizeYouTubeUrl = (value: unknown): string | null => {
  const videoId = getYouTubeVideoId(value);
  return videoId
    ? `https://www.youtube.com/watch?v=${videoId}`
    : null;
};

export const getYouTubeEmbedUrl = (videoId: unknown): string | null => {
  const normalizedId = cleanVideoId(videoId);
  return normalizedId
    ? `https://www.youtube-nocookie.com/embed/${normalizedId}`
    : null;
};

