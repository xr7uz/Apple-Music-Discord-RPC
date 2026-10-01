import { setTimeout as sleep } from "node:timers/promises";
import { defaultCacheFile, JsonCache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { type Activity, DiscordClient } from "./discord.ts";
import { log, setDebug } from "./log.ts";
import { ExtrasResolver, type TrackExtras } from "./lookup.ts";
import { detectPlayerApp, type PlayerApp, readSnapshot } from "./music.ts";
import { activityChanged, buildActivity } from "./presence.ts";

/**
 * Public Discord applications named "Music" and "iTunes" (the ones
 * NextFire/apple-music-discord-rpc uses). Their name is what Discord shows in
 * "Listening to …". Set MUSIC_RPC_CLIENT_ID to use your own application.
 */
const DEFAULT_CLIENT_IDS: Record<PlayerApp, string> = {
  Music: "773825528921849856",
  iTunes: "979297966739300416",
};

const config = loadConfig(process.env, (message) => log.warn(message));
setDebug(config.debug);

const app = config.app ?? (await detectPlayerApp());
const discord = new DiscordClient(config.clientId ?? DEFAULT_CLIENT_IDS[app]);
const cache = new JsonCache<TrackExtras>(defaultCacheFile("extras.json"));
await cache.load();
const resolver = new ExtrasResolver({
  cache,
  app,
  countries: [...new Set([config.country, "us", "jp"])],
  uploadArtwork: config.uploadArtwork,
});

/** What Discord currently shows. undefined = unknown, null = nothing. */
let shown: Activity | null | undefined;
let shownTrackId: string | undefined;
let waitingForDiscord = false;
let lastError = "";

async function tick(): Promise<number> {
  if (!discord.connected) {
    shown = undefined;
    try {
      await discord.connect();
      log.info("connected to Discord");
      waitingForDiscord = false;
    } catch (err) {
      if (!waitingForDiscord) log.info("waiting for Discord …");
      waitingForDiscord = true;
      log.debug(err);
      return config.idleMs;
    }
  }

  const { state, track, position = 0 } = await readSnapshot(app);
  log.debug("player", state, track ?? "", position);

  if (!track || !(state === "playing" || (state === "paused" && config.showPaused))) {
    if (shown !== null) {
      await discord.setActivity(null);
      if (shown) log.info(`presence cleared (${state})`);
      shown = null;
      shownTrackId = undefined;
    }
    return state === "closed" ? config.idleMs : config.pollMs;
  }

  const extras = await resolver.resolve(track);
  const activity = buildActivity({ track, state, position, extras, buttons: config.buttons });

  if (activityChanged(shown ?? undefined, activity)) {
    await discord.setActivity(activity);
    if (track.id !== shownTrackId) {
      log.info(`${state === "playing" ? "▶" : "⏸"} ${[track.artist, track.name].filter(Boolean).join(" — ")}`);
    }
    shown = activity;
    shownTrackId = track.id;
  }

  // wake up right as the track ends so the next one shows up instantly
  if (state === "playing" && track.duration) {
    const remainingMs = (track.duration - position) * 1000;
    return Math.max(1_000, Math.min(config.pollMs, remainingMs + 500));
  }
  return config.pollMs;
}

function explain(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("-1743")) {
    return `${message}\n  → allow "node" to control ${app} and System Events in System Settings › Privacy & Security › Automation`;
  }
  return message;
}

const stop = new AbortController();

async function shutdown(signal: string): Promise<void> {
  if (stop.signal.aborted) return;
  stop.abort();
  log.info(`${signal}, clearing presence`);
  if (discord.connected) await discord.setActivity(null, 2_000).catch(() => {});
  discord.close();
  await cache.flush().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

log.info(`apple-music-discord-rpc · ${app} · storefront ${config.country}`);

while (!stop.signal.aborted) {
  let delay = config.idleMs;
  try {
    delay = await tick();
    lastError = "";
  } catch (err) {
    const message = explain(err);
    // the same error every few seconds would flood the log
    if (message !== lastError) log.error(message);
    lastError = message;
    shown = undefined;
  }
  await sleep(delay, undefined, { signal: stop.signal }).catch(() => {});
}
