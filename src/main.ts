import { setTimeout as sleep } from "node:timers/promises";
import { uploadLocalArtwork } from "./artwork.ts";
import { defaultCacheFile, JsonCache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { type Activity, DiscordClient } from "./discord.ts";
import { log, setDebug, setLogFile } from "./log.ts";
import { ExtrasResolver, type TrackExtras } from "./lookup.ts";
import { detectMacApp, MacPlayer } from "./macos.ts";
import type { Player } from "./player.ts";
import { activityChanged, buildActivity } from "./presence.ts";
import { WindowsPlayer } from "./windows.ts";

/**
 * Public Discord applications named "Music" and "iTunes" (the ones
 * NextFire/apple-music-discord-rpc uses). Their name is what Discord shows in
 * "Listening to …". Set MUSIC_RPC_CLIENT_ID to use your own application.
 */
const CLIENT_ID_MUSIC = "773825528921849856";
const CLIENT_ID_ITUNES = "979297966739300416";

const config = loadConfig(process.env, (message) => log.warn(message));
setDebug(config.debug);
if (config.logFile) setLogFile(config.logFile);

let player: Player;
if (process.platform === "win32") {
  player = new WindowsPlayer({ app: config.windowsApp });
} else if (process.platform === "darwin") {
  player = new MacPlayer(config.app ?? (await detectMacApp()));
} else {
  log.error(`${process.platform} is not supported, only macOS and Windows`);
  process.exit(1);
}

const defaultClientId = player instanceof MacPlayer && player.app === "iTunes" ? CLIENT_ID_ITUNES : CLIENT_ID_MUSIC;
const discord = new DiscordClient(config.clientId ?? defaultClientId);
const cache = new JsonCache<TrackExtras>(defaultCacheFile("extras.json"));
await cache.load();
const resolver = new ExtrasResolver({
  cache,
  countries: [...new Set([config.country, "us", "jp"])],
  uploadArtwork: config.uploadArtwork ? () => uploadLocalArtwork((path) => player.exportArtwork(path)) : undefined,
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

  const { state, track, position } = await player.snapshot();
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
  if (state === "playing" && track.duration && position !== undefined) {
    const remainingMs = (track.duration - position) * 1000;
    return Math.max(1_000, Math.min(config.pollMs, remainingMs + 500));
  }
  return config.pollMs;
}

function explain(err: unknown): string {
  return player.explain(err instanceof Error ? err.message : String(err));
}

const stop = new AbortController();

async function shutdown(signal: string): Promise<void> {
  if (stop.signal.aborted) return;
  stop.abort();
  log.info(`${signal}, clearing presence`);
  if (discord.connected) await discord.setActivity(null, 2_000).catch(() => {});
  discord.close();
  player.close();
  await cache.flush().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

log.info(`apple-music-discord-rpc · ${player.name} · storefront ${config.country}`);

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
