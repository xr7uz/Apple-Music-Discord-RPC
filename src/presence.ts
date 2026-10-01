/** Turns player state into a Discord activity. Pure, so it's easy to test. */
import type { ButtonKind } from "./config.ts";
import { type Activity, ActivityType, StatusDisplay } from "./discord.ts";
import { cleanTitle, type TrackExtras } from "./lookup.ts";
import type { Track } from "./music.ts";

const TEXT_MIN = 2;
const TEXT_MAX = 128;
const URL_MAX = 512;

/** Discord rejects text fields shorter than 2 or longer than 128 characters. */
export function fitText(value: string, max = TEXT_MAX): string {
  const text = value.trim();
  if (text.length < TEXT_MIN) return text.padEnd(TEXT_MIN, "⠀");
  if (text.length <= max) return text;
  // cut on code points so emoji / surrogate pairs never get split
  let out = "";
  for (const char of text) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

function validUrl(value: string | undefined): string | undefined {
  return value && value.length <= URL_MAX && /^https?:\/\//.test(value) ? value : undefined;
}

export function buttonFor(kind: ButtonKind, track: Track, extras: TrackExtras): { label: string; url: string } | undefined {
  const query = encodeURIComponent([cleanTitle(track.name), track.artist].filter(Boolean).join(" "));
  switch (kind) {
    case "apple": {
      const url = validUrl(extras.trackUrl);
      return url ? { label: "Listen on Apple Music", url } : undefined;
    }
    case "spotify": {
      const url = validUrl(`https://open.spotify.com/search/${query}`);
      return url ? { label: "Search on Spotify", url } : undefined;
    }
    case "youtube": {
      const url = validUrl(`https://music.youtube.com/search?q=${query}`);
      return url ? { label: "Search on YouTube Music", url } : undefined;
    }
  }
}

export interface PresenceInput {
  track: Track;
  state: "playing" | "paused";
  /** Seconds into the track. */
  position: number;
  extras: TrackExtras;
  buttons: ButtonKind[];
  now?: number;
}

export function buildActivity({ track, state, position, extras, buttons, now = Date.now() }: PresenceInput): Activity {
  const activity: Activity = {
    type: ActivityType.Listening,
    details: fitText(state === "paused" ? `⏸ ${track.name}` : track.name),
    details_url: validUrl(extras.trackUrl),
  };

  if (track.artist) {
    activity.state = fitText(track.artist);
    activity.state_url = validUrl(extras.artistUrl);
    // member list reads "Listening to <artist>" instead of the app name
    activity.status_display_type = StatusDisplay.State;
  }

  if (state === "playing") {
    const start = Math.round(now - position * 1000);
    activity.timestamps = { start };
    if (track.duration && track.duration > 0) {
      activity.timestamps.end = Math.round(start + track.duration * 1000);
    }
  }

  const artwork = validUrl(extras.artworkUrl);
  if (artwork || track.album) {
    activity.assets = {
      large_image: artwork,
      large_text: track.album ? fitText(track.album) : undefined,
      large_url: validUrl(extras.albumUrl),
    };
  }

  const shown = buttons
    .map((kind) => buttonFor(kind, track, extras))
    .filter((button) => button !== undefined)
    .slice(0, 2);
  if (shown.length > 0) activity.buttons = shown;

  return activity;
}

/**
 * True when Discord needs an update: anything but the timestamps changed,
 * or playback jumped (seek, repeat) by more than `toleranceMs`.
 */
export function activityChanged(previous: Activity | undefined, next: Activity, toleranceMs = 1_500): boolean {
  if (!previous) return true;
  const { timestamps: prevTime, ...prevRest } = previous;
  const { timestamps: nextTime, ...nextRest } = next;
  if (JSON.stringify(prevRest) !== JSON.stringify(nextRest)) return true;
  if (!prevTime || !nextTime) return prevTime !== nextTime;
  return Math.abs((prevTime.start ?? 0) - (nextTime.start ?? 0)) > toleranceMs || Boolean(prevTime.end) !== Boolean(nextTime.end);
}
