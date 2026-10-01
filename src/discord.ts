/**
 * Discord RPC over the local IPC socket (discord-ipc-0 … discord-ipc-9).
 *
 * Every frame is an 8 byte header (opcode + payload length, both int32 LE)
 * followed by a UTF-8 JSON payload.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

export const ActivityType = { Playing: 0, Listening: 2, Watching: 3, Competing: 5 } as const;

/** Which field Discord shows in the member list: "Listening to <field>". */
export const StatusDisplay = { Name: 0, State: 1, Details: 2 } as const;

export interface Activity {
  type?: number;
  status_display_type?: number;
  details?: string;
  details_url?: string;
  state?: string;
  state_url?: string;
  timestamps?: { start?: number; end?: number };
  assets?: {
    large_image?: string;
    large_text?: string;
    large_url?: string;
    small_image?: string;
    small_text?: string;
    small_url?: string;
  };
  buttons?: { label: string; url: string }[];
}

export const Op = { Handshake: 0, Frame: 1, Close: 2, Ping: 3, Pong: 4 } as const;

export interface Frame {
  op: number;
  /** Arbitrary JSON sent by Discord. */
  data: any;
}

export function encodeFrame(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Reassembles frames from arbitrarily split socket chunks. */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: Frame[] = [];
    while (this.#buffer.length >= 8) {
      const op = this.#buffer.readInt32LE(0);
      const length = this.#buffer.readInt32LE(4);
      if (length < 0) throw new Error(`Invalid frame length ${length}`);
      if (this.#buffer.length < 8 + length) break;
      const body = this.#buffer.toString("utf8", 8, 8 + length);
      this.#buffer = this.#buffer.subarray(8 + length);
      frames.push({ op, data: JSON.parse(body) });
    }
    return frames;
  }
}

let darwinTempDir: string | undefined;

function ipcDirectories(): string[] {
  const env = process.env;
  const dirs = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP];
  if (process.platform === "darwin" && !env.TMPDIR) {
    // launchd normally sets TMPDIR, but ask the system if it didn't
    try {
      darwinTempDir ??= execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
      dirs.push(darwinTempDir);
    } catch {
      // ignore, fall back to /tmp
    }
  }
  dirs.push("/tmp");
  return [...new Set(dirs.filter((dir): dir is string => Boolean(dir)))];
}

/** Existing Discord IPC socket paths, in the order clients are expected to try them. */
export function ipcSocketPaths(): string[] {
  const paths: string[] = [];
  for (const dir of ipcDirectories()) {
    for (let i = 0; i < 10; i++) {
      const path = join(dir, `discord-ipc-${i}`);
      if (existsSync(path)) paths.push(path);
    }
  }
  return paths;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class DiscordClient {
  readonly clientId: string;
  #socket: Socket | undefined;
  #ready = false;
  #pending = new Map<string, Pending>();

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  get connected(): boolean {
    return this.#ready && this.#socket !== undefined && !this.#socket.destroyed;
  }

  /** Connects to the first Discord client that accepts the handshake. */
  async connect(timeoutMs = 5_000): Promise<void> {
    this.close();
    const paths = ipcSocketPaths();
    if (paths.length === 0) throw new Error("Discord is not running (no IPC socket found)");

    let lastError: unknown;
    for (const path of paths) {
      try {
        await this.#open(path, timeoutMs);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  #open(path: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path });
      const decoder = new FrameDecoder();
      this.#socket = socket;

      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => settle(new Error(`Discord handshake timed out (${path})`)), timeoutMs);

      socket.on("connect", () => {
        socket.write(encodeFrame(Op.Handshake, { v: 1, client_id: this.clientId }));
      });

      socket.on("data", (chunk: Buffer) => {
        let frames: Frame[];
        try {
          frames = decoder.push(chunk);
        } catch (err) {
          socket.destroy(err as Error);
          return;
        }
        for (const frame of frames) this.#handleFrame(socket, frame, settle);
      });

      socket.on("error", (err) => settle(err));

      socket.on("close", () => {
        settle(new Error("Discord closed the connection during the handshake"));
        // a socket replaced by close()/connect() was already cleaned up
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        this.#ready = false;
        this.#rejectPending(new Error("Discord connection closed"));
      });
    });
  }

  #handleFrame(socket: Socket, { op, data }: Frame, settle: (error?: Error) => void): void {
    switch (op) {
      case Op.Ping:
        socket.write(encodeFrame(Op.Pong, data));
        return;

      case Op.Close:
        settle(new Error(`Discord refused the connection: ${data?.message ?? "unknown reason"} (${data?.code})`));
        socket.end();
        return;

      case Op.Frame: {
        if (data?.cmd === "DISPATCH" && data?.evt === "READY") {
          this.#ready = true;
          settle();
          return;
        }
        const pending = typeof data?.nonce === "string" ? this.#pending.get(data.nonce) : undefined;
        if (!pending) return;
        this.#pending.delete(data.nonce);
        clearTimeout(pending.timer);
        if (data.evt === "ERROR") {
          pending.reject(new Error(`${data.data?.message ?? "Discord error"} (${data.data?.code})`));
        } else {
          pending.resolve(data.data);
        }
      }
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /** Sends a command and resolves with Discord's response payload. */
  request<T = unknown>(cmd: string, args: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    const socket = this.#socket;
    if (!socket || !this.connected) return Promise.reject(new Error("Not connected to Discord"));

    const nonce = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(nonce);
        reject(new Error(`Discord did not answer ${cmd} in time`));
      }, timeoutMs);
      this.#pending.set(nonce, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.write(encodeFrame(Op.Frame, { cmd, args, nonce }));
    });
  }

  /** Sets the presence, or clears it when `activity` is null. */
  setActivity(activity: Activity | null, timeoutMs?: number): Promise<unknown> {
    return this.request("SET_ACTIVITY", { pid: process.pid, activity: activity ?? undefined }, timeoutMs);
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#ready = false;
    socket?.destroy();
    this.#rejectPending(new Error("Discord connection closed"));
  }
}
