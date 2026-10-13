/**
 * macOS backend: talks to Music.app (or iTunes) through osascript.
 * All scripts are plain ES5 so they also run on older JavaScriptCore versions.
 */
import { execFile } from "node:child_process";
import type { Player, Snapshot } from "./player.ts";

export type MacApp = "Music" | "iTunes";

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

/** Music.app replaced iTunes in macOS 10.15 Catalina. */
export function playerForMacOS(version: string): MacApp {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 10 || (major === 10 && minor >= 15) ? "Music" : "iTunes";
}

export function detectMacApp(): Promise<MacApp> {
  return new Promise((resolve, reject) => {
    execFile("sw_vers", ["-productVersion"], (error, stdout) => {
      if (error) reject(new Error(`Could not read the macOS version: ${error.message}`));
      else resolve(playerForMacOS(stdout.trim()));
    });
  });
}

export class MacPlayer implements Player {
  readonly app: MacApp;
  readonly name: string;

  constructor(app: MacApp) {
    this.app = app;
    this.name = app;
  }

  snapshot(): Promise<Snapshot> {
    return runJxa<Snapshot>(SNAPSHOT, [this.app]);
  }

  /** AppleScript, because it can write raw picture data straight to disk. */
  async exportArtwork(outPath: string): Promise<boolean> {
    // `app` is one of two literals, so interpolating it is safe
    const script = `on run argv
  tell application "${this.app}"
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

  explain(message: string): string {
    if (!message.includes("-1743")) return message;
    return `${message}\n  → allow "node" to control ${this.app} and System Events in System Settings › Privacy & Security › Automation`;
  }

  close(): void {}
}
