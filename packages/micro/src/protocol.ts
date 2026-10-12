import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const MICRO_VENDOR_ID = 0x303a;
export const MICRO_PRODUCT_ID = 0x8360;
export const MICRO_USAGE_PAGE = 0xff00;
export const MICRO_REPORT_ID = 6;
export const MICRO_SLOTS = [0, 1, 2, 3, 4, 5] as const;
export const MICRO_SLOT_COUNT = MICRO_SLOTS.length;

const RpcMessage = Schema.Struct({
  method: Schema.optional(Schema.String),
  m: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  p: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.NullOr(Schema.Int)),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
export type RpcMessage = typeof RpcMessage.Type;
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(RpcMessage));

export function encodeReports(message: object) {
  const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\r\n`);
  const reports: Uint8Array<ArrayBuffer>[] = [];
  for (let start = 0; start < bytes.length; start += 61) {
    const payload = bytes.subarray(start, start + 61);
    const report = new Uint8Array(63);
    report[0] = 2;
    report[1] = payload.length;
    report.set(payload, 2);
    reports.push(report);
  }
  return reports;
}

export class ReportDecoder {
  private decoder = new TextDecoder();
  private buffer = "";

  read(reportId: number, data: DataView): RpcMessage[] {
    if (reportId !== MICRO_REPORT_ID || data.byteLength < 2 || data.getUint8(0) !== 2) return [];
    const length = data.getUint8(1);
    if (length > 61 || length > data.byteLength - 2) return [];
    this.buffer += this.decoder.decode(new Uint8Array(data.buffer, data.byteOffset + 2, length), {
      stream: true,
    });
    if (this.buffer.length > 16_384) {
      this.buffer = "";
      this.decoder = new TextDecoder();
      return [];
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const messages: RpcMessage[] = [];
    for (const line of lines) {
      const decoded = decodeMessage(line.trim());
      if (Option.isSome(decoded)) messages.push(decoded.value);
    }
    return messages;
  }
}

export const LED_COLORS = {
  idle: 0xffffff,
  working: 0x4d9aff,
  complete: 0x4acb81,
  input: 0xffc26e,
  error: 0xfb6f73,
  unavailable: 0x000000,
} as const;
export type MicroThreadStatus = keyof typeof LED_COLORS;

export function lightingMessage(statuses: readonly MicroThreadStatus[]) {
  return {
    method: "v.oai.thstatus",
    params: Array.from({ length: MICRO_SLOT_COUNT }, (_, id) => {
      const color = LED_COLORS[statuses[id] ?? "unavailable"];
      return { id, c: color, e: color === 0 ? 0 : 1, b: color === 0 ? 0 : 1, s: 0, sk: 0, sa: 0 };
    }),
  };
}
