import { describe, expect, it } from "vite-plus/test";
import {
  DEVICE_MEDIA_MAX_CONFIG_BYTES,
  DEVICE_MEDIA_MAX_PACKET_BYTES,
  DEVICE_MEDIA_MAX_READ_BYTES,
  DEVICE_MEDIA_MAX_READ_PACKETS,
} from "@supacode/contracts";

import { AvccEnvelopeParser } from "./avcc.ts";

const envelope = (tag: number, payload = Uint8Array.of(8, 9)) => {
  const bytes = new Uint8Array(payload.length + 5);
  new DataView(bytes.buffer).setUint32(0, payload.length + 1, false);
  bytes[4] = tag;
  bytes.set(payload, 5);
  return bytes;
};

const join = (parts: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};

describe("AvccEnvelopeParser", () => {
  it("preserves all known envelopes across every header and payload split", () => {
    const bytes = join([envelope(1), envelope(2), envelope(3), envelope(4)]);
    for (let offset = 0; offset <= bytes.length; offset++) {
      const parser = new AvccEnvelopeParser({ unknownTags: "reject" });
      expect([
        ...parser.push(bytes.subarray(0, offset)),
        ...parser.push(bytes.subarray(offset)),
      ]).toEqual([1, 2, 3, 4].map((tag) => ({ tag, payload: Uint8Array.of(8, 9) })));
      expect(() => parser.end()).not.toThrow();
    }
  });

  it("skips unknown tags across fragmented bodies without consuming the next packet", () => {
    const parser = new AvccEnvelopeParser({ unknownTags: "skip" });
    const bytes = join([envelope(15, new Uint8Array(4096)), envelope(2)]);
    expect([...parser.push(bytes.subarray(0, 1024))]).toEqual([]);
    expect([...parser.push(bytes.subarray(1024))]).toEqual([
      { tag: 2, payload: Uint8Array.of(8, 9) },
    ]);
  });

  it("rejects unknown tags before receiving their payload when requested", () => {
    const parser = new AvccEnvelopeParser({ unknownTags: "reject" });
    expect(() => [...parser.push(envelope(15).subarray(0, 5))]).toThrow("envelope tag");
  });

  it.each([0, 1, DEVICE_MEDIA_MAX_PACKET_BYTES + 2, 0xffffffff])(
    "rejects invalid length %s from the fragmented prefix alone",
    (length) => {
      const parser = new AvccEnvelopeParser({ unknownTags: "skip" });
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setUint32(0, length, false);
      expect([...parser.push(prefix.subarray(0, 3))]).toEqual([]);
      expect(() => [...parser.push(prefix.subarray(3))]).toThrow("envelope length");
    },
  );

  it("enforces the smaller configuration limit at the tag before allocating its body", () => {
    const parser = new AvccEnvelopeParser({ unknownTags: "reject" });
    const prefix = new Uint8Array(5);
    new DataView(prefix.buffer).setUint32(0, DEVICE_MEDIA_MAX_CONFIG_BYTES + 2, false);
    prefix[4] = 1;
    expect(() => [...parser.push(prefix)]).toThrow("description is too large");
  });

  it("accepts the exact configuration and packet limits", () => {
    for (const [tag, length] of [
      [1, DEVICE_MEDIA_MAX_CONFIG_BYTES],
      [2, DEVICE_MEDIA_MAX_PACKET_BYTES],
    ] as const) {
      const parser = new AvccEnvelopeParser({ unknownTags: "reject" });
      const payload = new Uint8Array(length).fill(17);
      const packets = [...parser.push(envelope(tag, payload))];
      expect(packets).toHaveLength(1);
      expect(packets[0]!.payload.length).toBe(length);
      expect(packets[0]!.payload[0]).toBe(17);
      expect(packets[0]!.payload.at(-1)).toBe(17);
      expect(() => parser.end()).not.toThrow();
    }
  });

  it("rejects oversized reads and excessive unknown envelopes", () => {
    const parser = new AvccEnvelopeParser({ unknownTags: "skip" });
    expect(() => [...parser.push(new Uint8Array(DEVICE_MEDIA_MAX_READ_BYTES + 1))]).toThrow(
      "read is too large",
    );
    const packets = join(
      Array.from({ length: DEVICE_MEDIA_MAX_READ_PACKETS + 1 }, () => envelope(15)),
    );
    expect(() => [...parser.push(packets)]).toThrow("too many envelopes");
  });

  it.each([1, 2, 3, 4, 5, 6])("detects truncated envelopes at byte %s", (length) => {
    const parser = new AvccEnvelopeParser({ unknownTags: "reject" });
    expect([...parser.push(envelope(2).subarray(0, length))]).toEqual([]);
    expect(() => parser.end()).toThrow("truncated");
  });

  it("owns yielded bytes and resets partial and malformed streams", () => {
    const parser = new AvccEnvelopeParser({ unknownTags: "reject" });
    const input = envelope(2);
    const first = [...parser.push(input)][0]!;
    input.fill(0);
    expect([...parser.push(envelope(3).subarray(0, 6))]).toEqual([]);
    parser.reset();
    expect([...parser.push(envelope(2))]).toHaveLength(1);
    expect(first.payload).toEqual(Uint8Array.of(8, 9));
    expect(() => [...parser.push(new Uint8Array(4))]).toThrow("envelope length");
    parser.reset();
    expect([...parser.push(envelope(4))][0]!.tag).toBe(4);
    expect(() => parser.end()).not.toThrow();
  });
});
