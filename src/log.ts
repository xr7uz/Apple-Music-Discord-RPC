/** Minimal timestamped logger. stdout/stderr end up in the launch agent log file. */

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
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
  stream.write(`${stamp()} ${level} ${parts.map(format).join(" ")}\n`);
}

export const log = {
  debug: (...parts: unknown[]) => debugEnabled && write(process.stdout, "·", parts),
  info: (...parts: unknown[]) => write(process.stdout, "›", parts),
  warn: (...parts: unknown[]) => write(process.stderr, "!", parts),
  error: (...parts: unknown[]) => write(process.stderr, "✗", parts),
};
