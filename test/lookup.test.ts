import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { JsonCache } from "../src/cache.ts";
import {
  type CatalogResult,
  cleanTitle,
  ExtrasResolver,
  findBestMatch,
  normalize,
  similarity,
  toExtras,
  type TrackExtras,
} from "../src/lookup.ts";
import type { Track } from "../src/music.ts";

const track: Track = { id: "A1B2", name: "Midnight Drive (feat. Someone)", artist: "Neon Coast", album: "Afterglow (Deluxe Edition)" };

const result = (overrides: Partial<CatalogResult>): CatalogResult => ({
  trackName: "Midnight Drive",
  artistName: "Neon Coast",
  collectionName: "Afterglow",
  artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/ab/cd/source/100x100bb.jpg",
  trackViewUrl: "https://music.apple.com/us/album/midnight-drive/111?i=222&uo=4",
  collectionViewUrl: "https://music.apple.com/us/album/afterglow/111?i=222&uo=4",
  artistViewUrl: "https://music.apple.com/us/artist/neon-coast/333?uo=4",
  ...overrides,
});

describe("normalize", () => {
  it("strips decoration, accents and punctuation", () => {
    assert.equal(cleanTitle("Song (Remastered 2011) [Live] - Single"), "Song");
    assert.equal(cleanTitle("Song feat. Somebody Else"), "Song");
    assert.equal(normalize("Beyoncé & JAY-Z"), "beyonce and jay z");
    assert.equal(normalize("(untitled)"), "untitled");
  });
});

describe("findBestMatch", () => {
  it("prefers the exact track over remixes and other artists", () => {
    const plain: Track = { ...track, name: "Midnight Drive", album: "Afterglow" };
    const results = [
      // decoration-only differences would tie without exact matches ranking higher
      result({ trackName: "Midnight Drive (feat. DJ) [Club Remix]", collectionName: "Afterglow (Remixes) - EP" }),
      result({ artistName: "Somebody Else", collectionName: "Covers" }),
      result({}),
    ];
    assert.equal(findBestMatch(plain, results), results[2]);
  });

  it("ranks exact, decorated and partial matches", () => {
    assert.equal(similarity("Afterglow", "afterglow"), 3);
    assert.equal(similarity("Afterglow", "Afterglow (Deluxe Edition)"), 2);
    assert.equal(similarity("Neon Coast", "Neon Coast, Someone & Other"), 1);
    assert.equal(similarity("Neon Coast", "Other"), 0);
    assert.equal(similarity("", "Other"), 0);
  });

  it("returns nothing when only the title matches", () => {
    assert.equal(findBestMatch(track, [result({ artistName: "Other", collectionName: "Other" })]), undefined);
  });

  it("accepts an album match when the artist is formatted differently", () => {
    const match = result({ artistName: "N. Coast" });
    assert.equal(findBestMatch(track, [match]), match);
  });
});

describe("toExtras", () => {
  it("upscales artwork and removes tracking params", () => {
    assert.deepEqual(toExtras(result({})), {
      artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/ab/cd/source/512x512bb.jpg",
      trackUrl: "https://music.apple.com/us/album/midnight-drive/111?i=222",
      albumUrl: "https://music.apple.com/us/album/afterglow/111",
      artistUrl: "https://music.apple.com/us/artist/neon-coast/333",
    });
  });
});

describe("ExtrasResolver", () => {
  const dir = mkdtempSync(join(tmpdir(), "rpc-lookup-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  function setup(responses: Record<string, () => Response>, upload?: () => Promise<{ url: string; expiresAt: number } | undefined>) {
    const requested: string[] = [];
    const cache = new JsonCache<TrackExtras>(join(dir, `${Math.random()}.json`));
    const resolver = new ExtrasResolver({
      cache,
      app: "Music",
      countries: ["de", "us"],
      uploadArtwork: upload !== undefined,
      upload,
      fetch: async (input) => {
        const url = new URL(String(input));
        const country = url.searchParams.get("country")!;
        requested.push(country);
        const respond = responses[country];
        if (!respond) throw new Error("offline");
        return respond();
      },
    });
    return { resolver, requested, cache };
  }

  it("falls back to the next storefront and caches the result", async () => {
    const { resolver, requested } = setup({ de: () => json({ results: [] }), us: () => json({ results: [result({})] }) });
    const first = await resolver.resolve(track);
    const second = await resolver.resolve(track);
    assert.deepEqual(requested, ["de", "us"]);
    assert.equal(first.trackUrl, "https://music.apple.com/us/album/midnight-drive/111?i=222");
    assert.equal(second, first);
  });

  it("uploads local artwork when the catalog has no match", async () => {
    let uploads = 0;
    const { resolver } = setup({ de: () => json({ results: [] }), us: () => json({ results: [] }) }, async () => {
      uploads++;
      return { url: "https://litter.catbox.moe/abc.jpg", expiresAt: Date.now() + 60 * 60 * 1000 };
    });
    assert.deepEqual(await resolver.resolve(track), { artworkUrl: "https://litter.catbox.moe/abc.jpg" });
    await resolver.resolve(track);
    assert.equal(uploads, 1);
  });

  it("survives network errors and retries soon", async () => {
    const { resolver, cache } = setup({ de: () => json({}, 503) });
    assert.deepEqual(await resolver.resolve(track), {});
    assert.deepEqual(cache.get(track.id), {});
    assert.equal(cache.get(track.id, Date.now() + 6 * 60 * 1000), undefined);
  });
});
