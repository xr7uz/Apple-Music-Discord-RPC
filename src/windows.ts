/**
 * Windows backend: reads the Apple Music (or iTunes) session from the Windows
 * media controls through one long-lived PowerShell process (windows-media.ps1).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Player, PlayerState, Snapshot, Track } from "./player.ts";

/** Matches the Apple Music app ("AppleInc.AppleMusicWin_…!App") and iTunes. */
export const DEFAULT_WINDOWS_APP = "AppleMusic|iTunes";

const SCRIPT = fileURLToPath(new URL("./windows-media.ps1", import.meta.url));

/** What windows-media.ps1 answers to a snapshot request. */
export interface MediaSession {
  state: PlayerState;
  title?: string | null;
  artist?: string | null;
  albumArtist?: string | null;
  album?: string | null;
  duration?: number;
  position?: number;
  error?: string;
}

/** Apple Music for Windows reports "Artist — Album" as the artist and leaves the album empty. */
export function splitArtistAlbum(artist: string, album: string): { artist: string; album: string } {
  if (album) return { artist, album };
  const match = /\s[—–]\s/.exec(artist);
  if (!match) return { artist, album };
  return { artist: artist.slice(0, match.index).trim(), album: artist.slice(match.index + match[0].length).trim() };
}

export function trackId(name: string, artist: string, album: string): string {
  return createHash("sha1").update(`${name}\u0000${artist}\u0000${album}`).digest("hex").slice(0, 16);
}

/**
 * Fallback for players that don't report a timeline: counts playing time from
 * the moment a track change was seen. The first track after startup stays unknown.
 */
export class PositionEstimator {
  #id: string | undefined;
  #position: number | undefined;
  #at = 0;
  #playing = false;

  update(id: string, playing: boolean, now: number): number | undefined {
    if (id !== this.#id) {
      this.#position = this.#id === undefined ? undefined : 0;
      this.#id = id;
    } else if (this.#position !== undefined && this.#playing) {
      this.#position += (now - this.#at) / 1000;
    }
    this.#at = now;
    this.#playing = playing;
    return this.#position;
  }

  reset(): void {
    this.#id = undefined;
    this.#position = undefined;
  }
}

export function toSnapshot(session: MediaSession, estimator: PositionEstimator, now: number): Snapshot {
  if (session.state === "closed") {
    estimator.reset();
    return { state: "closed" };
  }
  if ((session.state !== "playing" && session.state !== "paused") || !session.title) return { state: "stopped" };

  const { artist, album } = splitArtistAlbum(session.artist || session.albumArtist || "", session.album || "");
  const track: Track = {
    id: trackId(session.title, artist, album),
    name: session.title,
    artist,
    album,
    duration: session.duration && session.duration > 0 ? session.duration : undefined,
  };
  const estimated = estimator.update(track.id, session.state === "playing", now);
  return { state: session.state, track, position: session.position ?? estimated };
}

/** Escapes non-ASCII so the request survives any console code page. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface WindowsPlayerOptions {
  /** Regex matched against the media session's app id. */
  app?: string;
  /** Starts the helper process. Tests swap in a fake. */
  start?: () => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
}

export class WindowsPlayer implements Player {
  readonly name = "Apple Music (Windows)";
  readonly #start: () => ChildProcessWithoutNullStreams;
  readonly #timeoutMs: number;
  readonly #estimator = new PositionEstimator();
  #process: ChildProcessWithoutNullStreams | undefined;
  #queue: Pending[] = [];

  constructor({ app = DEFAULT_WINDOWS_APP, start, timeoutMs = 15_000 }: WindowsPlayerOptions = {}) {
    this.#timeoutMs = timeoutMs;
    this.#start =
      start ??
      (() =>
        spawn(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
          { windowsHide: true, env: { ...process.env, MUSIC_RPC_WINDOWS_APP: app } },
        ));
  }

  #ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.#process) return this.#process;

    const child = this.#start();
    this.#process = child;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      // late output of a helper we already replaced must not answer the new one's requests
      if (this.#process !== child) return;
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newline).replace(/^\uFEFF/, "").trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const pending = this.#queue.shift();
        if (!pending) continue;
        clearTimeout(pending.timer);
        try {
          pending.resolve(JSON.parse(line));
        } catch {
          pending.reject(new Error(`Unexpected output from PowerShell: ${line.slice(0, 200)}`));
        }
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });

    const fail = (reason: string) => {
      if (this.#process !== child) return;
      this.#process = undefined;
      const detail = stderr.trim().split("\n").find((l) => l.trim()) ?? "";
      const error = new Error(`PowerShell media helper ${reason}${detail ? `: ${detail.trim()}` : ""}`);
      for (const pending of this.#queue.splice(0)) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    };
    child.on("error", (err) => fail(`could not start (${err.message})`));
    child.on("exit", (code) => fail(`exited with code ${code}`));
    child.stdin.on("error", () => {}); // reported through "exit"

    return child;
  }

  #request<T>(payload: Record<string, unknown>): Promise<T> {
    const child = this.#ensureProcess();
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#queue.splice(this.#queue.indexOf(pending), 1);
          reject(new Error("PowerShell media helper did not answer in time"));
          // a stuck helper can't be trusted with the next answer either
          this.close();
        }, this.#timeoutMs),
      };
      this.#queue.push(pending);
      child.stdin.write(`${asciiJson(payload)}\n`);
    });
  }

  async snapshot(): Promise<Snapshot> {
    const session = await this.#request<MediaSession>({ cmd: "snapshot" });
    if (session.error) throw new Error(`Windows media controls: ${session.error}`);
    return toSnapshot(session, this.#estimator, Date.now());
  }

  async exportArtwork(outPath: string): Promise<boolean> {
    const result = await this.#request<{ ok?: boolean; error?: string }>({ cmd: "artwork", path: outPath });
    if (result.error) throw new Error(`Windows media controls: ${result.error}`);
    return result.ok === true;
  }

  explain(message: string): string {
    if (!/Windows\.Media\.Control|TypeNotFound|Unable to find type/i.test(message)) return message;
    return `${message}\n  → needs Windows 10 (1809) or newer with Windows PowerShell 5.1`;
  }

  close(): void {
    const child = this.#process;
    this.#process = undefined;
    for (const pending of this.#queue.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error("PowerShell media helper stopped"));
    }
    child?.kill();
  }
}
