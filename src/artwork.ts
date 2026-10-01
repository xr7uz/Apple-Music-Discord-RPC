/** Fallback for tracks the catalog doesn't know: upload the embedded artwork for an hour. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportArtwork, type PlayerApp } from "./music.ts";

const LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php";
const LITTERBOX_TTL_MS = 60 * 60 * 1000;

export interface UploadedArtwork {
  url: string;
  expiresAt: number;
}

export function detectImage(bytes: Uint8Array): { mime: string; ext: string } | undefined {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  if (starts(0xff, 0xd8, 0xff)) return { mime: "image/jpeg", ext: "jpg" };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { mime: "image/png", ext: "png" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { mime: "image/gif", ext: "gif" };
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (starts(0x42, 0x4d)) return { mime: "image/bmp", ext: "bmp" };
  return undefined;
}

export async function uploadToLitterbox(bytes: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<UploadedArtwork> {
  const image = detectImage(bytes);
  if (!image) throw new Error("Artwork is not a known image format");

  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("time", "1h");
  form.append("fileToUpload", new Blob([bytes], { type: image.mime }), `artwork.${image.ext}`);

  const response = await fetchImpl(LITTERBOX_API, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  const text = (await response.text()).trim();
  if (!response.ok || !text.startsWith("https://")) {
    throw new Error(`litterbox upload failed: ${response.status} ${text.slice(0, 120)}`);
  }
  return { url: text, expiresAt: Date.now() + LITTERBOX_TTL_MS };
}

/** Exports the current track's artwork and uploads it. Undefined if the track has none. */
export async function uploadLocalArtwork(app: PlayerApp): Promise<UploadedArtwork | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "music-rpc-"));
  try {
    const file = join(dir, "artwork");
    if (!(await exportArtwork(app, file))) return undefined;
    return await uploadToLitterbox(await readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
