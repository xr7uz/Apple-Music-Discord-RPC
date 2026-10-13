/** Minimal timestamped logger. Writes to stdout/stderr, or to a file when one is set. */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

let debugEnabled = false;
let logFile: string | undefined;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Sends all output to `path`, keeping the previous file as .old once it passes 1 MB. */
export function setLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size > 1024 * 1024) renameSync(path, `${path}.old`);
  } catch {
    // no log yet
  }
  logFile = path;
}

function stamp(): string {
  // sv-SE formats as "YYYY-MM-DD HH:MM:SS" in local time
  return new Date().toLocaleString("sv-SE");
}

function format(value: unknown): string {
  if (value instanceof Error) return debugEnabled ? (value.stack ?? value.message) : value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function write(stream: NodeJS.WriteStream, level: string, parts: unknown[]): void {
  const line = `${stamp()} ${level} ${parts.map(format).join(" ")}\n`;
  if (logFile) {
    try {
      appendFileSync(logFile, line);
      return;
    } catch {
      // fall back to the stream
    }
  }
  stream.write(line);
}

export const log = {
  debug: (...parts: unknown[]) => debugEnabled && write(process.stdout, "·", parts),
  info: (...parts: unknown[]) => write(process.stdout, "›", parts),
  warn: (...parts: unknown[]) => write(process.stderr, "!", parts),
  error: (...parts: unknown[]) => write(process.stderr, "✗", parts),
};
