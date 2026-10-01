/**
 * Talks to Music.app (or iTunes) through osascript.
 * All scripts are plain ES5 so they also run on older JavaScriptCore versions.
 */
import { execFile } from "node:child_process";

export type PlayerApp = "Music" | "iTunes";
export type PlayerState = "closed" | "stopped" | "playing" | "paused";

export interface Track {
  /** Persistent library id, stable across restarts. */
  id: string;
  name: string;
  artist: string;
  album: string;
  /** Seconds. Missing for radio streams. */
  duration?: number;
}

export interface Snapshot {
  state: PlayerState;
  /** Seconds into the current track. */
  position?: number;
  track?: Track;
}

function osascript(args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;
        reject(new Error(`osascript: ${detail}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Runs a JXA function with JSON-serializable arguments and returns its JSON result.
 * Arguments travel through argv, so nothing is ever interpolated into the source.
 */
export async function runJxa<T>(fn: string, args: unknown[] = []): Promise<T> {
  const program = `function run(argv) {
  var main = (${fn});
  return JSON.stringify(main.apply(null, JSON.parse(argv[0])));
}`;
  const out = await osascript(["-l", "JavaScript", "-e", program, JSON.stringify(args)]);
  return JSON.parse(out) as T;
}

const SNAPSHOT = `function (appName) {
  // Checking System Events first avoids launching the player by accident
  if (!Application("System Events").processes[appName].exists()) return { state: "closed" };

  var player = Application(appName);
  var state = player.playerState();
  if (state === "fast forwarding" || state === "rewinding") state = "playing";
  if (state !== "playing" && state !== "paused") return { state: "stopped" };

  var props;
  try {
    props = player.currentTrack().properties();
  } catch (e) {
    return { state: "stopped" };
  }

  return {
    state: state,
    position: player.playerPosition(),
    track: {
      id: props.persistentID,
      name: props.name || "",
      artist: props.artist || props.albumArtist || "",
      album: props.album || "",
      duration: props.duration || undefined
    }
  };
}`;

export function readSnapshot(app: PlayerApp): Promise<Snapshot> {
  return runJxa<Snapshot>(SNAPSHOT, [app]);
}

/**
 * Writes the current track's embedded artwork to `outPath`.
 * Uses AppleScript because it can write raw picture data straight to disk.
 */
export async function exportArtwork(app: PlayerApp, outPath: string): Promise<boolean> {
  // `app` is one of two literals, so interpolating it is safe
  const script = `on run argv
  tell application "${app}"
    if (count of artworks of current track) is 0 then return "none"
    set artData to raw data of artwork 1 of current track
  end tell
  set fileRef to open for access (POSIX file (item 1 of argv)) with write permission
  try
    set eof fileRef to 0
    write artData to fileRef
    close access fileRef
  on error errMsg
    close access fileRef
    error errMsg
  end try
  return "ok"
end run`;
  return (await osascript(["-e", script, outPath])) === "ok";
}

/** Music.app replaced iTunes in macOS 10.15 Catalina. */
export function playerForMacOS(version: string): PlayerApp {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 10 || (major === 10 && minor >= 15) ? "Music" : "iTunes";
}

export function detectPlayerApp(): Promise<PlayerApp> {
  return new Promise((resolve, reject) => {
    execFile("sw_vers", ["-productVersion"], (error, stdout) => {
      if (error) reject(new Error(`Could not read the macOS version: ${error.message}`));
      else resolve(playerForMacOS(stdout.trim()));
    });
  });
}
