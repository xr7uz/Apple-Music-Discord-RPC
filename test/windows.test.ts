import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PositionEstimator, splitArtistAlbum, toSnapshot, trackId, WindowsPlayer } from "../src/windows.ts";

describe("splitArtistAlbum", () => {
  it("splits Apple Music's combined artist field", () => {
    assert.deepEqual(splitArtistAlbum("Neon Coast — Afterglow", ""), { artist: "Neon Coast", album: "Afterglow" });
  });

  it("keeps proper fields untouched", () => {
    assert.deepEqual(splitArtistAlbum("Neon Coast — Live", "Afterglow"), { artist: "Neon Coast — Live", album: "Afterglow" });
    assert.deepEqual(splitArtistAlbum("Jay-Z", ""), { artist: "Jay-Z", album: "" });
  });
});

describe("toSnapshot", () => {
  const session = { state: "playing" as const, title: "Midnight Drive", artist: "Neon Coast — Afterglow", album: "" };

  it("maps a media session to a track", () => {
    const snapshot = toSnapshot({ ...session, duration: 211.5, position: 30 }, new PositionEstimator(), 0);
    assert.deepEqual(snapshot, {
      state: "playing",
      position: 30,
      track: {
        id: trackId("Midnight Drive", "Neon Coast", "Afterglow"),
        name: "Midnight Drive",
        artist: "Neon Coast",
        album: "Afterglow",
        duration: 211.5,
      },
    });
  });

  it("reports closed and stopped players", () => {
    assert.deepEqual(toSnapshot({ state: "closed" }, new PositionEstimator(), 0), { state: "closed" });
    assert.deepEqual(toSnapshot({ state: "stopped" }, new PositionEstimator(), 0), { state: "stopped" });
    assert.deepEqual(toSnapshot({ state: "playing", title: "" }, new PositionEstimator(), 0), { state: "stopped" });
  });

  it("estimates the position when there is no timeline", () => {
    const estimator = new PositionEstimator();
    // first track after startup: unknown
    assert.equal(toSnapshot(session, estimator, 0).position, undefined);
    // a witnessed track change starts at 0 and counts up while playing
    const next = { ...session, title: "Other Song" };
    assert.equal(toSnapshot(next, estimator, 10_000).position, 0);
    assert.equal(toSnapshot(next, estimator, 15_000).position, 5);
    assert.equal(toSnapshot({ ...next, state: "paused" }, estimator, 20_000).position, 10);
    assert.equal(toSnapshot({ ...next, state: "paused" }, estimator, 60_000).position, 10);
    assert.equal(toSnapshot(next, estimator, 61_000).position, 10);
    assert.equal(toSnapshot(next, estimator, 63_000).position, 12);
  });
});

/** Speaks the windows-media.ps1 protocol: one JSON line in, one out. */
const FAKE_HELPER = `
const { writeFileSync } = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
let count = 0;
rl.on("line", (line) => {
  const req = JSON.parse(line);
  count++;
  if (process.env.FAKE_CRASH && count === 2) process.exit(3);
  if (process.env.FAKE_HANG) return;
  let res;
  if (req.cmd === "snapshot") res = { state: "playing", title: "Mi\\u00f1a \\u266b", artist: "Neon Coast \\u2014 Afterglow", album: "", position: 1.5, duration: 200 };
  else if (req.cmd === "artwork") { writeFileSync(req.path, Buffer.from([0xff, 0xd8, 0xff])); res = { ok: true }; }
  else res = { error: "unknown command" };
  // split the answer to check line reassembly
  const out = JSON.stringify(res) + "\\r\\n";
  process.stdout.write(out.slice(0, 5));
  process.stdout.write(out.slice(5));
});
`;

function fakePlayer(env: Record<string, string> = {}, timeoutMs?: number): WindowsPlayer {
  return new WindowsPlayer({
    timeoutMs,
    start: () => spawn(process.execPath, ["-e", FAKE_HELPER], { env: { ...process.env, ...env } }),
  });
}

describe("WindowsPlayer", () => {
  const dir = mkdtempSync(join(tmpdir(), "rpc-win-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads snapshots and artwork through the helper", async () => {
    const player = fakePlayer();
    try {
      const snapshot = await player.snapshot();
      assert.equal(snapshot.track?.name, "Miña ♫");
      assert.equal(snapshot.track?.artist, "Neon Coast");
      assert.equal(snapshot.track?.album, "Afterglow");
      assert.equal(snapshot.position, 1.5);

      // concurrent requests are answered in order
      const [a, b] = await Promise.all([player.snapshot(), player.snapshot()]);
      assert.equal(a.state, "playing");
      assert.equal(b.state, "playing");

      const file = join(dir, "artwork");
      assert.equal(await player.exportArtwork(file), true);
      assert.deepEqual([...readFileSync(file)], [0xff, 0xd8, 0xff]);
    } finally {
      player.close();
    }
  });

  it("restarts the helper after it dies", async () => {
    const player = fakePlayer({ FAKE_CRASH: "1" });
    try {
      await player.snapshot();
      await assert.rejects(player.snapshot(), /exited with code 3/);
      assert.equal((await player.snapshot()).state, "playing");
    } finally {
      player.close();
    }
  });

  it("gives up on a helper that hangs", async () => {
    const player = fakePlayer({ FAKE_HANG: "1" }, 300);
    try {
      await assert.rejects(player.snapshot(), /did not answer in time/);
    } finally {
      player.close();
    }
  });
});
