import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DiscordClient, encodeFrame, type Frame, FrameDecoder, Op } from "../src/discord.ts";

type Handler = (socket: Socket, frame: Frame) => void;

/** Replies like Discord: READY after the handshake, echo for commands. */
const discordLike: Handler = (socket, { op, data }) => {
  if (op === Op.Handshake) {
    socket.write(encodeFrame(Op.Frame, { cmd: "DISPATCH", evt: "READY", data: { v: 1 } }));
  } else if (op === Op.Frame) {
    socket.write(encodeFrame(Op.Frame, { cmd: data.cmd, evt: null, nonce: data.nonce, data: data.args.activity ?? null }));
  }
};

let dir: string;
let server: Server | undefined;
const received: Frame[] = [];

async function startServer(handler: Handler): Promise<void> {
  await stopServer();
  received.length = 0;
  server = createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        received.push(frame);
        handler(socket, frame);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server!.listen(join(dir, "discord-ipc-0"), resolve));
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
}

describe("FrameDecoder", () => {
  it("reassembles frames split across chunks", () => {
    const bytes = Buffer.concat([encodeFrame(Op.Frame, { a: 1 }), encodeFrame(Op.Ping, { b: "ü" })]);
    const decoder = new FrameDecoder();
    const frames: Frame[] = [];
    for (const byte of bytes) frames.push(...decoder.push(Buffer.from([byte])));
    assert.deepEqual(frames, [
      { op: Op.Frame, data: { a: 1 } },
      { op: Op.Ping, data: { b: "ü" } },
    ]);
  });
});

describe("DiscordClient", () => {
  const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "rpc-test-"));
    process.env.XDG_RUNTIME_DIR = dir;
  });

  after(async () => {
    await stopServer();
    rmSync(dir, { recursive: true, force: true });
    if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
  });

  it("handshakes and sets / clears the activity", async () => {
    await startServer(discordLike);
    const client = new DiscordClient("123456789012345678");
    await client.connect();
    assert.equal(client.connected, true);
    assert.deepEqual(received[0], { op: Op.Handshake, data: { v: 1, client_id: "123456789012345678" } });

    const echoed = await client.setActivity({ type: 2, details: "Song" });
    assert.deepEqual(echoed, { type: 2, details: "Song" });
    assert.equal(received[1]?.data.cmd, "SET_ACTIVITY");
    assert.equal(received[1]?.data.args.pid, process.pid);

    await client.setActivity(null);
    assert.equal("activity" in received[2]?.data.args, false);
    client.close();
    assert.equal(client.connected, false);
  });

  it("answers pings", async () => {
    await startServer((socket, frame) => {
      discordLike(socket, frame);
      if (frame.op === Op.Handshake) socket.write(encodeFrame(Op.Ping, { t: 1 }));
    });
    const client = new DiscordClient("123456789012345678");
    await client.connect();
    await client.setActivity(null); // round trip, so the pong has arrived
    assert.deepEqual(received.find((f) => f.op === Op.Pong)?.data, { t: 1 });
    client.close();
  });

  it("rejects commands Discord answers with ERROR", async () => {
    await startServer((socket, frame) => {
      if (frame.op === Op.Handshake) return discordLike(socket, frame);
      socket.write(
        encodeFrame(Op.Frame, { evt: "ERROR", nonce: frame.data.nonce, data: { code: 4000, message: "child \"activity\" fails" } }),
      );
    });
    const client = new DiscordClient("123456789012345678");
    await client.connect();
    await assert.rejects(client.setActivity({ details: "x" }), /child "activity" fails \(4000\)/);
    client.close();
  });

  it("fails the handshake on a close frame", async () => {
    await startServer((socket) => socket.write(encodeFrame(Op.Close, { code: 4000, message: "Invalid Client ID" })));
    const client = new DiscordClient("1");
    await assert.rejects(client.connect(), /Invalid Client ID/);
    assert.equal(client.connected, false);
  });

  it("rejects pending requests when Discord goes away", async () => {
    await startServer((socket, frame) => {
      if (frame.op === Op.Handshake) discordLike(socket, frame);
      else socket.destroy();
    });
    const client = new DiscordClient("123456789012345678");
    await client.connect();
    await assert.rejects(client.setActivity({ details: "x" }), /connection closed/);
    assert.equal(client.connected, false);
  });

  it("reports when no Discord client is running", async () => {
    await stopServer();
    const client = new DiscordClient("123456789012345678");
    const realTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    // only look in the empty test directory (plus /tmp, which CI keeps clean)
    process.env.TMPDIR = dir;
    delete process.env.TMP;
    delete process.env.TEMP;
    try {
      await assert.rejects(client.connect(), /no IPC socket found|ECONNREFUSED|ENOENT/);
    } finally {
      for (const [key, value] of Object.entries(realTmp)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
