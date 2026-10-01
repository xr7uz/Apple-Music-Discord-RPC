import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Track } from "../src/music.ts";
import { activityChanged, buildActivity, fitText } from "../src/presence.ts";

const track: Track = { id: "A1B2", name: "Midnight Drive", artist: "Neon Coast", album: "Afterglow", duration: 211.5 };
const extras = {
  artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/x/512x512bb.jpg",
  trackUrl: "https://music.apple.com/us/album/afterglow/1?i=2",
  albumUrl: "https://music.apple.com/us/album/afterglow/1",
  artistUrl: "https://music.apple.com/us/artist/neon-coast/3",
};
const now = 1_700_000_000_000;

describe("fitText", () => {
  it("pads text Discord would consider too short", () => {
    assert.equal(fitText("A").length, 2);
  });

  it("keeps normal text as is", () => {
    assert.equal(fitText("  Midnight Drive "), "Midnight Drive");
  });

  it("truncates to 128 characters with an ellipsis", () => {
    const out = fitText("x".repeat(300));
    assert.equal(out.length, 128);
    assert.ok(out.endsWith("…"));
  });

  it("never splits a surrogate pair", () => {
    const out = fitText("🎵".repeat(100));
    assert.ok(out.length <= 128);
    assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("buildActivity", () => {
  it("builds a listening activity with progress, artwork and links", () => {
    const activity = buildActivity({ track, state: "playing", position: 30, extras, buttons: ["apple", "spotify"], now });
    assert.deepEqual(activity, {
      type: 2,
      status_display_type: 1,
      details: "Midnight Drive",
      details_url: extras.trackUrl,
      state: "Neon Coast",
      state_url: extras.artistUrl,
      timestamps: { start: now - 30_000, end: now - 30_000 + 211_500 },
      assets: { large_image: extras.artworkUrl, large_text: "Afterglow", large_url: extras.albumUrl },
      buttons: [
        { label: "Listen on Apple Music", url: extras.trackUrl },
        { label: "Search on Spotify", url: "https://open.spotify.com/search/Midnight%20Drive%20Neon%20Coast" },
      ],
    });
  });

  it("drops the progress bar while paused", () => {
    const activity = buildActivity({ track, state: "paused", position: 30, extras, buttons: [], now });
    assert.equal(activity.timestamps, undefined);
    assert.equal(activity.details, "⏸ Midnight Drive");
    assert.equal(activity.buttons, undefined);
  });

  it("has no end time for streams without a duration", () => {
    const radio = { ...track, duration: undefined };
    const activity = buildActivity({ track: radio, state: "playing", position: 5, extras: {}, buttons: [], now });
    assert.deepEqual(activity.timestamps, { start: now - 5_000 });
  });

  it("skips the apple button without a catalog match", () => {
    const activity = buildActivity({ track, state: "playing", position: 0, extras: {}, buttons: ["apple", "youtube"], now });
    assert.deepEqual(activity.buttons, [
      { label: "Search on YouTube Music", url: "https://music.youtube.com/search?q=Midnight%20Drive%20Neon%20Coast" },
    ]);
    assert.equal(activity.details_url, undefined);
  });

  it("leaves state empty for tracks without an artist", () => {
    const activity = buildActivity({ track: { ...track, artist: "" }, state: "playing", position: 0, extras: {}, buttons: [], now });
    assert.equal(activity.state, undefined);
    assert.equal(activity.status_display_type, undefined);
  });
});

describe("activityChanged", () => {
  const base = buildActivity({ track, state: "playing", position: 30, extras, buttons: [], now });

  it("ignores polling jitter", () => {
    const later = buildActivity({ track, state: "playing", position: 35.2, extras, buttons: [], now: now + 5_000 });
    assert.equal(activityChanged(base, later), false);
  });

  it("detects seeks", () => {
    const seeked = buildActivity({ track, state: "playing", position: 120, extras, buttons: [], now: now + 5_000 });
    assert.equal(activityChanged(base, seeked), true);
  });

  it("detects track and state changes", () => {
    const next = buildActivity({ track: { ...track, id: "C3", name: "Other" }, state: "playing", position: 0, extras, buttons: [], now });
    const paused = buildActivity({ track, state: "paused", position: 30, extras, buttons: [], now });
    assert.equal(activityChanged(base, next), true);
    assert.equal(activityChanged(base, paused), true);
    assert.equal(activityChanged(undefined, base), true);
  });
});
