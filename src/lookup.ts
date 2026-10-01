/** Finds artwork and Apple Music links for a track via the public iTunes Search API. */
import { uploadLocalArtwork, type UploadedArtwork } from "./artwork.ts";
import type { JsonCache } from "./cache.ts";
import { log } from "./log.ts";
import type { PlayerApp, Track } from "./music.ts";

export interface TrackExtras {
  artworkUrl?: string;
  trackUrl?: string;
  albumUrl?: string;
  artistUrl?: string;
}

export interface CatalogResult {
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  trackViewUrl?: string;
  collectionViewUrl?: string;
  artistViewUrl?: string;
}

const HOUR = 60 * 60 * 1000;
const TTL = {
  /** Catalog data barely changes. */
  hit: 7 * 24 * HOUR,
  /** Retry misses daily, the catalog grows. */
  miss: 24 * HOUR,
  /** Network trouble, try again soon. */
  error: 5 * 60 * 1000,
  /** Refresh uploads a bit before litterbox deletes them. */
  uploadMargin: 10 * 60 * 1000,
};

/** Strips featurings, bracketed suffixes like "(Deluxe Edition)" or "[Remastered]". */
export function cleanTitle(value: string): string {
  const cleaned = value
    .replace(/\s*[([][^)\]]*[)\]]/g, " ")
    .replace(/\s+-\s+(single|ep)$/i, "")
    .replace(/\s(feat|ft|featuring)\.?\s.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || value.trim();
}

/** Comparison key: no accents, case or punctuation. */
function key(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Comparison key that also ignores featurings and decoration like "(Deluxe Edition)". */
export function normalize(value: string): string {
  return key(cleanTitle(value));
}

/** 3 = same, 2 = same apart from decoration, 1 = one contains the other, 0 = different. */
export function similarity(a: string, b: string): number {
  const looseA = normalize(a);
  const looseB = normalize(b);
  if (!looseA || !looseB) return 0;
  if (key(a) === key(b)) return 3;
  if (looseA === looseB) return 2;
  return looseA.includes(looseB) || looseB.includes(looseA) ? 1 : 0;
}

/**
 * Picks the result matching the title plus artist or album. Exact matches beat
 * decorated ones, so "Song" on "Album" wins over "Song (Remix)" on "Album (Remixes)".
 * Ties keep the API's relevance order.
 */
export function findBestMatch(track: Track, results: CatalogResult[]): CatalogResult | undefined {
  let best: CatalogResult | undefined;
  let bestScore = 0;
  for (const result of results) {
    const name = similarity(track.name, result.trackName ?? "");
    const artist = similarity(track.artist, result.artistName ?? "");
    const album = similarity(track.album, result.collectionName ?? "");
    if (name === 0 || (artist === 0 && album === 0)) continue;

    const score = name * 3 + artist * 2 + album;
    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
  }
  return best;
}

/** Upscales mzstatic artwork (100x100 by default) and drops tracking params from links. */
export function toExtras(result: CatalogResult): TrackExtras {
  const link = (value?: string, ...dropParams: string[]) => {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      for (const param of ["uo", ...dropParams]) url.searchParams.delete(param);
      return url.toString();
    } catch {
      return undefined;
    }
  };
  return {
    artworkUrl: result.artworkUrl100?.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/, "/512x512bb.$1"),
    trackUrl: link(result.trackViewUrl),
    // song results point the album link at the song too
    albumUrl: link(result.collectionViewUrl, "i"),
    artistUrl: link(result.artistViewUrl),
  };
}

export function searchUrl(track: Track, country: string): string {
  const term = [cleanTitle(track.name), track.artist || cleanTitle(track.album)].filter(Boolean).join(" ");
  const params = new URLSearchParams({ term, country, media: "music", entity: "song", limit: "25" });
  return `https://itunes.apple.com/search?${params}`;
}

export interface ResolverOptions {
  cache: JsonCache<TrackExtras>;
  app: PlayerApp;
  /** Storefronts to try, in order. */
  countries: string[];
  uploadArtwork: boolean;
  fetch?: typeof fetch;
  upload?: (app: PlayerApp) => Promise<UploadedArtwork | undefined>;
}

export class ExtrasResolver {
  readonly #options: ResolverOptions;
  readonly #fetch: typeof fetch;
  readonly #upload: (app: PlayerApp) => Promise<UploadedArtwork | undefined>;

  constructor(options: ResolverOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#upload = options.upload ?? uploadLocalArtwork;
  }

  /** Cached lookup. Never throws: a failed lookup just means fewer extras. */
  async resolve(track: Track): Promise<TrackExtras> {
    const { cache, app, uploadArtwork } = this.#options;
    const cached = cache.get(track.id);
    if (cached) return cached;

    let extras: TrackExtras = {};
    let ttl = TTL.miss;

    const { result, failed } = await this.#search(track);
    if (result) {
      extras = toExtras(result);
      ttl = TTL.hit;
    } else if (failed) {
      ttl = TTL.error;
    }

    if (!extras.artworkUrl && uploadArtwork) {
      try {
        const uploaded = await this.#upload(app);
        if (uploaded) {
          extras.artworkUrl = uploaded.url;
          ttl = Math.min(ttl, uploaded.expiresAt - Date.now() - TTL.uploadMargin);
          log.debug("uploaded local artwork", uploaded.url);
        }
      } catch (err) {
        log.warn("artwork upload failed:", err);
        ttl = Math.min(ttl, TTL.error);
      }
    }

    cache.set(track.id, extras, Math.max(ttl, TTL.error));
    return extras;
  }

  async #search(track: Track): Promise<{ result?: CatalogResult; failed: boolean }> {
    let failed = false;
    for (const country of this.#options.countries) {
      const url = searchUrl(track, country);
      try {
        const response = await this.#fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        const body = (await response.json()) as { results?: CatalogResult[] };
        const result = findBestMatch(track, body.results ?? []);
        log.debug(`catalog ${country}:`, result ? `${result.artistName} — ${result.trackName}` : "no match");
        if (result) return { result, failed: false };
      } catch (err) {
        failed = true;
        log.warn(`catalog lookup failed (${country}):`, err);
      }
    }
    return { failed };
  }
}
