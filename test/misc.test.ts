import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { detectImage } from "../src/artwork.ts";
import { JsonCache } from "../src/cache.ts";
import { loadConfig } from "../src/config.ts";
import { playerForMacOS } from "../src/music.ts";

describe("loadConfig", () => {
  it("has sensible defaults", () => {
    const config = loadConfig({}, assert.fail);
    assert.deepEqual(config, {
      app: undefined,
      clientId: undefined,
      country: "us",
      buttons: ["apple", "spotify"],
      showPaused: false,
      uploadArtwork: true,
      pollMs: 5_000,
      idleMs: 15_000,
      debug: false,
    });
  });

  it("reads MUSIC_RPC_* variables", () => {
    const config = loadConfig(
      {
        MUSIC_RPC_APP: "itunes",
        MUSIC_RPC_CLIENT_ID: "123456789012345678",
        MUSIC_RPC_COUNTRY: "DE",
        MUSIC_RPC_BUTTONS: "youtube, apple",
        MUSIC_RPC_SHOW_PAUSED: "yes",
        MUSIC_RPC_UPLOAD_ARTWORK: "off",
        MUSIC_RPC_POLL_MS: "3000",
      },
      assert.fail,
    );
    assert.equal(config.app, "iTunes");
    assert.equal(config.clientId, "123456789012345678");
    assert.equal(config.country, "de");
    assert.deepEqual(config.buttons, ["youtube", "apple"]);
    assert.equal(config.showPaused, true);
    assert.equal(config.uploadArtwork, false);
    assert.equal(config.pollMs, 3_000);
  });

  it("warns and falls back on invalid values", () => {
    const warnings: string[] = [];
    const config = loadConfig(
      { MUSIC_RPC_COUNTRY: "germany", MUSIC_RPC_POLL_MS: "fast", MUSIC_RPC_BUTTONS: "apple,spotify,youtube,tidal" },
      (message) => warnings.push(message),
    );
    assert.equal(config.country, "us");
    assert.equal(config.pollMs, 5_000);
    assert.deepEqual(config.buttons, ["apple", "spotify"]);
    assert.equal(warnings.length, 4);
  });

  it("turns buttons off with none", () => {
    assert.deepEqual(loadConfig({ MUSIC_RPC_BUTTONS: "none" }, assert.fail).buttons, []);
  });
});

describe("JsonCache", () => {
  const dir = mkdtempSync(join(tmpdir(), "rpc-cache-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("expires entries and persists the rest", async () => {
    const path = join(dir, "nested", "cache.json");
    const cache = new JsonCache<string>(path);
    cache.set("fresh", "a", 60_000);
    cache.set("stale", "b", 1);
    assert.equal(cache.get("fresh"), "a");
    assert.equal(cache.get("stale", Date.now() + 10), undefined);
    await cache.flush();

    const reloaded = new JsonCache<string>(path);
    await reloaded.load();
    assert.equal(reloaded.get("fresh"), "a");
    assert.equal(reloaded.size, 1);
  });

  it("drops the oldest entries beyond its limit", () => {
    const cache = new JsonCache<number>(join(dir, "small.json"), 2);
    cache.set("a", 1, 60_000);
    cache.set("b", 2, 60_000);
    cache.set("a", 3, 60_000);
    cache.set("c", 4, 60_000);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 3);
    assert.equal(cache.get("c"), 4);
  });

  it("ignores a missing or corrupt file", async () => {
    const missing = new JsonCache<string>(join(dir, "missing.json"));
    await missing.load();
    assert.equal(missing.size, 0);

    writeFileSync(join(dir, "corrupt.json"), "{ not json");
    const corrupt = new JsonCache<string>(join(dir, "corrupt.json"));
    await corrupt.load();
    assert.equal(corrupt.size, 0);
  });
});

describe("playerForMacOS", () => {
  it("uses Music from Catalina on", () => {
    assert.equal(playerForMacOS("10.14.6"), "iTunes");
    assert.equal(playerForMacOS("10.9"), "iTunes");
    assert.equal(playerForMacOS("10.15"), "Music");
    assert.equal(playerForMacOS("15.4.1"), "Music");
  });
});

describe("detectImage", () => {
  it("recognizes common artwork formats", () => {
    assert.equal(detectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.mime, "image/jpeg");
    assert.equal(detectImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))?.mime, "image/png");
    assert.equal(detectImage(new Uint8Array([0, 1, 2, 3])), undefined);
  });
});
