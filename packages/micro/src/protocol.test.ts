import { describe, expect, it } from "vite-plus/test";
import { encodeReports, lightingMessage, MICRO_REPORT_ID, ReportDecoder } from "./protocol.ts";

describe("Micro protocol", () => {
  it("reassembles fragmented UTF-8 messages with WebHID's separate report ID", () => {
    const original = { method: "example", params: { title: "é".repeat(110) }, id: 8 };
    const reports = encodeReports(original);
    const decoder = new ReportDecoder();
    const decoded = reports.flatMap((report) =>
      decoder.read(MICRO_REPORT_ID, new DataView(report.buffer)),
    );
    expect(reports.length).toBeGreaterThan(1);
    expect(
      reports.every((report) => report.length === 63 && report[0] === 2 && (report[1] ?? 0) <= 61),
    ).toBe(true);
    expect(decoded).toEqual([original]);
  });

  it("ignores malformed reports without corrupting the next message", () => {
    const decoder = new ReportDecoder();
    expect(decoder.read(6, new DataView(Uint8Array.from([2, 62]).buffer))).toEqual([]);
    expect(decoder.read(1, new DataView(new ArrayBuffer(63)))).toEqual([]);
    const messages = encodeReports({ method: "v.oai.hid", params: { k: "ACT07", act: 1 } }).flatMap(
      (report) => decoder.read(6, new DataView(report.buffer)),
    );
    expect(messages[0]?.method).toBe("v.oai.hid");
  });

  it("clears all unassigned slots instead of leaving stale agent lights", () => {
    const message = lightingMessage(["working", "input"]);
    expect(message.params).toHaveLength(6);
    expect(message.params[0]).toMatchObject({ id: 0, c: 0x4d9aff, e: 1 });
    expect(message.params[1]).toMatchObject({ id: 1, c: 0xffc26e, e: 1 });
    expect(message.params.slice(2).every((slot) => slot.e === 0 && slot.b === 0)).toBe(true);
  });
});
