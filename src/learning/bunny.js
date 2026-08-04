import crypto from "node:crypto";

const VIDEO_ID = /^[0-9a-f-]{36}$/i;

export function createBunnyPlaybackUrl(environment, videoId, now = Date.now()) {
  if (!VIDEO_ID.test(String(videoId ?? ""))) return null;
  if (!environment.bunnyStreamLibraryId || !environment.bunnyStreamTokenKey) return null;
  const expires = Math.floor(now / 1_000) + environment.bunnyPlaybackTokenTtlSeconds;
  const token = crypto
    .createHash("sha256")
    .update(`${environment.bunnyStreamTokenKey}${videoId}${expires}`)
    .digest("hex");
  const origin = environment.bunnyStreamEmbedOrigin.replace(/\/$/, "");
  return {
    url: `${origin}/embed/${encodeURIComponent(environment.bunnyStreamLibraryId)}/${encodeURIComponent(videoId)}?token=${token}&expires=${expires}`,
    expiresAt: new Date(expires * 1_000).toISOString(),
  };
}

export function bunnyMaterialUrl(environment, materialPath) {
  if (!environment.bunnyStorageZone || !environment.bunnyStorageAccessKey || !materialPath) return null;
  const origin = environment.bunnyStorageApiOrigin.replace(/\/$/, "");
  const safePath = String(materialPath)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${origin}/${encodeURIComponent(environment.bunnyStorageZone)}/${safePath}`;
}
