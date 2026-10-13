import {
  DEVICE_MEDIA_MAX_CONFIG_BYTES,
  DEVICE_MEDIA_MAX_PACKET_BYTES,
  DEVICE_MEDIA_MAX_READ_BYTES,
  DEVICE_MEDIA_MAX_READ_PACKETS,
} from "@supacode/contracts";

export class AvccEnvelopeParser {
  private readonly header = new Uint8Array(5);
  private headerLength = 0;
  private payload: Uint8Array | undefined;
  private payloadLength = 0;
  private frameLength = 0;
  private tag: 1 | 2 | 3 | 4 | undefined;
  private readonly unknownTags: "skip" | "reject";

  constructor(options: { readonly unknownTags: "skip" | "reject" }) {
    this.unknownTags = options.unknownTags;
  }

  *push(bytes: Uint8Array) {
    if (bytes.byteLength > DEVICE_MEDIA_MAX_READ_BYTES)
      throw new Error("Device video read is too large.");
    let offset = 0;
    let completed = 0;
    while (offset < bytes.byteLength) {
      if (this.headerLength < 4) {
        const count = Math.min(4 - this.headerLength, bytes.byteLength - offset);
        this.header.set(bytes.subarray(offset, offset + count), this.headerLength);
        this.headerLength += count;
        offset += count;
        if (this.headerLength < 4) break;
        this.frameLength = new DataView(this.header.buffer).getUint32(0, false);
        if (this.frameLength < 2 || this.frameLength > DEVICE_MEDIA_MAX_PACKET_BYTES + 1)
          throw new Error("Invalid device video envelope length.");
      }
      if (this.headerLength === 4) {
        if (offset === bytes.byteLength) break;
        const tag = bytes[offset++]!;
        this.headerLength = 5;
        this.tag = tag === 1 || tag === 2 || tag === 3 || tag === 4 ? tag : undefined;
        if (this.tag === undefined && this.unknownTags === "reject")
          throw new Error("Unsupported device video envelope tag.");
        if (this.tag === 1 && this.frameLength - 1 > DEVICE_MEDIA_MAX_CONFIG_BYTES)
          throw new Error("Device video description is too large.");
        this.payload = this.tag === undefined ? undefined : new Uint8Array(this.frameLength - 1);
      }
      const count = Math.min(this.frameLength - 1 - this.payloadLength, bytes.byteLength - offset);
      this.payload?.set(bytes.subarray(offset, offset + count), this.payloadLength);
      this.payloadLength += count;
      offset += count;
      if (this.payloadLength === this.frameLength - 1) {
        if (++completed > DEVICE_MEDIA_MAX_READ_PACKETS)
          throw new Error("Device video read has too many envelopes.");
        const tag = this.tag;
        const payload = this.payload;
        this.reset();
        if (tag !== undefined && payload) yield { tag, payload };
      }
    }
  }

  end(): void {
    if (this.headerLength !== 0) throw new Error("Device video envelope was truncated.");
  }

  reset(): void {
    this.headerLength = 0;
    this.payloadLength = 0;
    this.frameLength = 0;
    this.payload = undefined;
    this.tag = undefined;
  }
}
