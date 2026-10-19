// @effect-diagnostics nodeBuiltinImport:off - real endpoint crypto verifies interoperable encrypted records.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  acceptClientHandshake,
  createClientHandshake,
  relayPublicKey,
  relayHttpBaseUrl,
} from "./protocol.ts";
import {
  createTunnelSession,
  createTunnelConnector,
  TUNNEL_KEEPALIVE_MS,
  TUNNEL_MAX_PLAIN_BYTES,
  TUNNEL_STREAM_WINDOW,
  type TunnelStream,
} from "./tunnel.ts";

function pair(onStream: (stream: TunnelStream) => void = () => {}, failSend = false) {
  const identity = NodeCrypto.randomBytes(32);
  const handshake = createClientHandshake(relayPublicKey(identity), NodeCrypto.randomBytes);
  const accepted = acceptClientHandshake(handshake.hello, identity, NodeCrypto.randomBytes);
  const clientCipher = handshake.finish(accepted.welcome);
  const toHost: Uint8Array[] = [];
  const toClient: Uint8Array[] = [];
  const client = createTunnelSession({
    cipher: clientCipher,
    initiator: true,
    send: (data) => {
      if (failSend) throw new Error("Socket send failed");
      toHost.push(data);
    },
  });
  const host = createTunnelSession({
    cipher: accepted.cipher,
    initiator: false,
    send: (data) => toClient.push(data),
    onStream,
  });
  async function drain() {
    for (let round = 0; round < 1000; round++) {
      await Promise.resolve();
      if (toHost.length === 0 && toClient.length === 0) return;
      for (const data of toHost.splice(0)) host.receive(data);
      for (const data of toClient.splice(0)) client.receive(data);
    }
    throw new Error("Tunnel did not quiesce");
  }
  return { client, host, clientCipher, toHost, toClient, drain };
}

describe("encrypted relay multiplexing", () => {
  it("stops opening streams when a callback closes the session", async () => {
    let opened = 0;
    const p = pair(() => {
      opened++;
      p.host.close();
    });
    p.client.open();
    p.client.open();
    await p.drain();
    expect(opened).toBe(1);
    expect(p.host.closed).toBe(true);
    p.client.close();
  });

  it("fails a writer whose bytes were removed from the queue before send throws", async () => {
    const p = pair(undefined, true);
    let failure: Error | undefined;
    p.client.open().write(Uint8Array.of(1), (error) => {
      failure = error;
    });
    await p.drain();
    expect(failure?.message).toBe("Socket send failed");
    expect(p.client.closed).toBe(true);
    p.host.close();
  });

  it("cancels a pending handshake when its connector is disposed", async () => {
    let closed = false;
    const connector = createTunnelConnector(
      relayHttpBaseUrl(relayPublicKey(NodeCrypto.randomBytes(32))),
      {
        randomBytes: NodeCrypto.randomBytes,
        createSocket: () => ({
          readyState: 0,
          addEventListener: () => {},
          removeEventListener: () => {},
          send: () => {},
          close: () => {
            closed = true;
          },
        }),
      },
    );
    const connecting = connector.session();
    connector.close();
    expect(closed).toBe(true);
    await expect(connecting).rejects.toThrow("canceled");
    await expect(connector.session()).rejects.toThrow("closed");
  });
  it("ends a full record without exceeding the wire limit", async () => {
    const received: Uint8Array[] = [];
    let ended = false;
    const p = pair((stream) => {
      stream.onData = (data) => {
        received.push(data);
        stream.consumed(data.length);
      };
      stream.onEnd = () => {
        ended = true;
        stream.end();
      };
    });
    const stream = p.client.open();
    const payload = NodeCrypto.randomBytes(TUNNEL_MAX_PLAIN_BYTES - 18);
    stream.write(payload);
    stream.end();
    await Promise.resolve();
    expect(p.toHost.every((record) => record.length <= TUNNEL_MAX_PLAIN_BYTES + 24)).toBe(true);
    await p.drain();
    expect(Buffer.concat(received)).toEqual(payload);
    expect(ended).toBe(true);
    expect(p.host.closed).toBe(false);
    expect(p.client.streamCount).toBe(0);
    p.client.close();
    p.host.close();
  });

  it("streams a large upload with bounded writes and independent streams", async () => {
    const hashes = new Map<number, ReturnType<typeof NodeCrypto.createHash>>();
    const p = pair((stream) => {
      const hash = NodeCrypto.createHash("sha256");
      hashes.set(stream.id, hash);
      stream.onData = (data) => {
        hash.update(data);
        stream.consumed(data.length);
      };
      stream.onEnd = () => stream.end();
    });
    const a = p.client.open();
    const b = p.client.open();
    const expected = NodeCrypto.createHash("sha256");
    for (let i = 0; i < 320; i++) {
      const chunk = NodeCrypto.randomBytes(64 * 1024);
      expected.update(chunk);
      a.write(chunk);
      b.write(Uint8Array.of(i % 256));
      await p.drain();
    }
    a.end();
    b.end();
    await p.drain();
    expect(hashes.get(a.id)?.digest("hex")).toBe(expected.digest("hex"));
    expect(p.client.streamCount).toBe(0);
    expect(p.host.closed).toBe(false);
    p.client.close();
    p.host.close();
  });

  it("stalls at a slow reader's window and resumes after consumption", async () => {
    let received = 0;
    let hostStream: TunnelStream | undefined;
    const p = pair((stream) => {
      hostStream = stream;
      stream.onData = (data) => {
        received += data.length;
      };
    });
    const stream = p.client.open();
    stream.write(new Uint8Array(TUNNEL_STREAM_WINDOW + 1024));
    await p.drain();
    expect(received).toBe(TUNNEL_STREAM_WINDOW);
    hostStream?.consumed(TUNNEL_STREAM_WINDOW);
    await p.drain();
    expect(received).toBe(TUNNEL_STREAM_WINDOW + 1024);
    p.client.close();
    p.host.close();
  });

  it("bounds a session when many readers stall", async () => {
    let received = 0;
    const p = pair((stream) => {
      stream.onData = (data) => {
        received += data.length;
      };
    });
    for (let i = 0; i < 8; i++) p.client.open().write(new Uint8Array(TUNNEL_STREAM_WINDOW));
    await p.drain();
    expect(received).toBeGreaterThan(TUNNEL_STREAM_WINDOW);
    expect(received).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(p.host.closed).toBe(false);
    p.client.close();
    p.host.close();
  });

  it("keeps a consuming stream moving while stalled readers hold most of the session", async () => {
    let delivered = 0;
    const p = pair((stream) => {
      stream.onData = (data) => {
        if (stream.id !== 7) return;
        delivered += data.length;
        stream.consumed(data.length);
      };
    });
    for (let i = 0; i < 3; i++) p.client.open().write(new Uint8Array(TUNNEL_STREAM_WINDOW));
    await p.drain();
    const active = p.client.open();
    expect(active.id).toBe(7);
    for (let i = 0; i < 16; i++) {
      active.write(new Uint8Array(1024 * 1024));
      await p.drain();
    }
    expect(delivered).toBe(16 * 1024 * 1024);
    expect(p.host.closed).toBe(false);
    p.client.close();
    p.host.close();
  });

  it("flushes a pending grant once stalled streams leave the sender short", async () => {
    let delivered = 0;
    const p = pair((stream) => {
      stream.onData = (data) => {
        if (stream.id !== 1) return;
        delivered += data.length;
        stream.consumed(data.length);
      };
    });
    const active = p.client.open();
    active.write(new Uint8Array(2_060_000));
    await p.drain();
    for (let i = 0; i < 3; i++) p.client.open().write(new Uint8Array(TUNNEL_STREAM_WINDOW));
    await p.drain();
    active.write(new Uint8Array(1024 * 1024));
    await p.drain();
    expect(delivered).toBe(2_060_000 + 1024 * 1024);
    p.client.close();
    p.host.close();
  });

  it("returns a consumed stream's credit when it shares records with a stalled stream", async () => {
    let delivered = 0;
    const p = pair((stream) => {
      stream.onData = (data) => {
        if (stream.id !== 3) return;
        delivered += data.length;
        stream.consumed(data.length);
      };
    });
    const stalled = p.client.open();
    const active = p.client.open();
    for (let i = 0; i < 256; i++) {
      if (i < 160) stalled.write(new Uint8Array(256));
      active.write(new Uint8Array(256));
      await p.drain();
    }
    expect(delivered).toBe(256 * 256);
    p.client.close();
    p.host.close();
  });

  it("coalesces queued writes into one record", async () => {
    const received: number[] = [];
    const p = pair((stream) => {
      stream.onData = (data) => {
        received.push(...data);
        stream.consumed(data.length);
      };
    });
    const stream = p.client.open();
    for (let i = 0; i < 10; i++) stream.write(Uint8Array.of(i));
    await Promise.resolve();
    expect(p.toHost).toHaveLength(1);
    await p.drain();
    expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    p.client.close();
    p.host.close();
  });

  it("answers keepalive pings and closes a session whose peer goes silent", async () => {
    vi.useFakeTimers();
    try {
      const p = pair();
      await vi.advanceTimersByTimeAsync(TUNNEL_KEEPALIVE_MS);
      expect(p.toHost.length).toBeGreaterThan(0);
      for (let i = 0; i < 5; i++) {
        await p.drain();
        await vi.advanceTimersByTimeAsync(TUNNEL_KEEPALIVE_MS);
      }
      expect(p.client.closed).toBe(false);
      expect(p.host.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(TUNNEL_KEEPALIVE_MS * 3);
      expect(p.client.closed).toBe(true);
      expect(p.host.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a peer that bypasses cumulative stream credit", async () => {
    const p = pair();
    p.client.open();
    await p.drain();
    const frame = new Uint8Array(TUNNEL_MAX_PLAIN_BYTES);
    const view = new DataView(frame.buffer);
    view.setUint8(0, 2);
    view.setUint32(1, 1);
    view.setUint32(5, frame.length - 9);
    for (let i = 0; i < 66 && !p.host.closed; i++) p.host.receive(p.clientCipher.seal(frame));
    expect(p.host.closed).toBe(true);
    p.client.close();
  });

  it("rejects stream reuse and malformed control frames", async () => {
    for (const [type, id, length] of [
      [1, 1, 0],
      [4, 1, 1],
      [5, 1, 1],
      [3, 0, 4],
      [6, 1, 0],
      [7, 0, 1],
    ]) {
      const p = pair();
      p.client.open();
      await p.drain();
      const frame = new Uint8Array(9 + length!);
      const view = new DataView(frame.buffer);
      view.setUint8(0, type!);
      view.setUint32(1, id!);
      view.setUint32(5, length!);
      p.host.receive(p.clientCipher.seal(frame));
      expect(p.host.closed).toBe(true);
      p.client.close();
    }
  });

  it("fails pending writers and all streams when the session closes", () => {
    const p = pair();
    const stream = p.client.open();
    let error: Error | undefined;
    let closed = false;
    stream.write(Uint8Array.of(1), (failure) => {
      error = failure;
    });
    stream.onClose = () => {
      closed = true;
    };
    p.client.close(new Error("Disconnected"));
    expect(error?.message).toBe("Disconnected");
    expect(closed).toBe(true);
    expect(() => p.client.open()).toThrow("closed");
    p.host.close();
  });
});

describe("host record compression", () => {
  const frames = (plain: Uint8Array) => {
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const parsed: { type: number; id: number; payload: Uint8Array }[] = [];
    for (let offset = 0; offset < plain.length;) {
      const length = view.getUint32(offset + 5);
      parsed.push({
        type: view.getUint8(offset),
        id: view.getUint32(offset + 1),
        payload: plain.slice(offset + 9, offset + 9 + length),
      });
      offset += 9 + length;
    }
    return parsed;
  };

  it("deflates large compressible records for a client that offered it", async () => {
    const identity = NodeCrypto.randomBytes(32);
    const handshake = createClientHandshake(relayPublicKey(identity), NodeCrypto.randomBytes);
    expect(acceptClientHandshake(handshake.hello, identity, NodeCrypto.randomBytes).deflate).toBe(
      false,
    );
    const hello = JSON.stringify({ ...JSON.parse(handshake.hello), compression: "deflate" });
    const accepted = acceptClientHandshake(hello, identity, NodeCrypto.randomBytes);
    expect(accepted.deflate).toBe(true);
    const cipher = handshake.finish(accepted.welcome);
    const toHost: Uint8Array[] = [];
    const toClient: Uint8Array[] = [];
    let hostStream: TunnelStream | undefined;
    const client = createTunnelSession({ cipher, initiator: true, send: (r) => toHost.push(r) });
    const host = createTunnelSession({
      cipher: accepted.cipher,
      initiator: false,
      send: (record) => toClient.push(record),
      deflate: (plain) => NodeZlib.deflateRawSync(plain),
      onStream: (stream) => {
        hostStream = stream;
      },
    });
    const id = client.open().id;
    await Promise.resolve();
    for (const record of toHost.splice(0)) host.receive(record);

    const received = async (bytes: Uint8Array) => {
      hostStream!.write(bytes);
      await Promise.resolve();
      expect(toClient).toHaveLength(1);
      return cipher.open(toClient.shift()!, TUNNEL_MAX_PLAIN_BYTES);
    };
    const text = new TextEncoder().encode(
      JSON.stringify(Array.from({ length: 64 }, (_, i) => ({ type: "event", sequence: i }))),
    );
    const [deflated] = frames(await received(text));
    expect(deflated).toMatchObject({ type: 8, id: 0 });
    expect(frames(new Uint8Array(NodeZlib.inflateRawSync(deflated!.payload)))).toEqual([
      { type: 2, id, payload: text },
    ]);

    const small = text.subarray(0, 200);
    expect(frames(await received(small))).toEqual([{ type: 2, id, payload: small }]);
    const random = new Uint8Array(NodeCrypto.randomBytes(4096));
    expect(frames(await received(random))).toEqual([{ type: 2, id, payload: random }]);
    client.close();
    host.close();
  });
});
