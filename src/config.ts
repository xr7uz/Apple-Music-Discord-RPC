import type { PlayerApp } from "./music.ts";

export const BUTTON_KINDS = ["apple", "spotify", "youtube"] as const;
export type ButtonKind = (typeof BUTTON_KINDS)[number];

export interface Config {
  /** Force "Music" or "iTunes" instead of detecting it from the macOS version. */
  app?: PlayerApp;
  /** Discord application id. Defaults to one matching the player app. */
  clientId?: string;
  /** Apple Music storefront used for catalog lookups and links. */
  country: string;
  /** Up to two buttons shown on the presence. */
  buttons: ButtonKind[];
  /** Keep the presence (without progress bar) while paused. */
  showPaused: boolean;
  /** Upload local artwork to litterbox.catbox.moe when the catalog has none. */
  uploadArtwork: boolean;
  /** Poll interval while the player is open. */
  pollMs: number;
  /** Poll interval while the player or Discord is closed. */
  idleMs: number;
  debug: boolean;
}

type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

export function loadConfig(env: Env = process.env, warn: Warn = console.warn): Config {
  const read = (name: string) => {
    const value = env[`MUSIC_RPC_${name}`]?.trim();
    return value ? value : undefined;
  };

  const bool = (name: string, fallback: boolean) => {
    const raw = read(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (TRUE.has(raw)) return true;
    if (FALSE.has(raw)) return false;
    warn(`MUSIC_RPC_${name}="${raw}" is not a boolean, using ${fallback}`);
    return fallback;
  };

  const ms = (name: string, fallback: number, min: number) => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= min) return value;
    warn(`MUSIC_RPC_${name}="${raw}" must be an integer >= ${min}, using ${fallback}`);
    return fallback;
  };

  let app: PlayerApp | undefined;
  const rawApp = read("APP")?.toLowerCase();
  if (rawApp === "music") app = "Music";
  else if (rawApp === "itunes") app = "iTunes";
  else if (rawApp !== undefined) warn(`MUSIC_RPC_APP="${rawApp}" must be "music" or "itunes", detecting instead`);

  let clientId = read("CLIENT_ID");
  if (clientId !== undefined && !/^\d{17,20}$/.test(clientId)) {
    warn(`MUSIC_RPC_CLIENT_ID="${clientId}" is not a Discord application id, using the default`);
    clientId = undefined;
  }

  let country = read("COUNTRY")?.toLowerCase() ?? "us";
  if (!/^[a-z]{2}$/.test(country)) {
    warn(`MUSIC_RPC_COUNTRY="${country}" must be a two-letter country code, using "us"`);
    country = "us";
  }

  const buttons: ButtonKind[] = [];
  const rawButtons = read("BUTTONS")?.toLowerCase() ?? "apple,spotify";
  if (rawButtons !== "none") {
    for (const item of rawButtons.split(",").map((s) => s.trim()).filter(Boolean)) {
      const kind = BUTTON_KINDS.find((k) => k === item);
      if (!kind) warn(`MUSIC_RPC_BUTTONS: unknown button "${item}", expected ${BUTTON_KINDS.join(", ")} or none`);
      else if (!buttons.includes(kind)) buttons.push(kind);
    }
    if (buttons.length > 2) {
      warn("MUSIC_RPC_BUTTONS: Discord shows at most two buttons, ignoring the rest");
      buttons.length = 2;
    }
  }

  return {
    app,
    clientId,
    country,
    buttons,
    showPaused: bool("SHOW_PAUSED", false),
    uploadArtwork: bool("UPLOAD_ARTWORK", true),
    pollMs: ms("POLL_MS", 5_000, 1_000),
    idleMs: ms("IDLE_MS", 15_000, 1_000),
    debug: bool("DEBUG", false),
  };
}
