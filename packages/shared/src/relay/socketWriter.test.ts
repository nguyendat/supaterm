import { afterEach, expect, it, vi } from "vite-plus/test";
import { createSocketWriter } from "./socketWriter.ts";

afterEach(() => vi.useRealTimers());

function fixture() {
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    addEventListener() {},
    removeEventListener() {},
    close() {},
    send(data: string | Uint8Array) {
      socket.bufferedAmount += data.length;
    },
  };
  return { socket, writer: createSocketWriter(socket, 256) };
}

it("blocks further records at the outer queue limit until it drains", async () => {
  vi.useFakeTimers();
  const { socket, writer } = fixture();
  expect(writer.send(new Uint8Array(128))).toBeUndefined();
  const drained = vi.fn();
  const pending = writer.send(new Uint8Array(128))!;
  void pending.then(drained);
  socket.bufferedAmount = 128;
  await vi.advanceTimersByTimeAsync(20);
  expect(drained).not.toHaveBeenCalled();
  socket.bufferedAmount = 64;
  await vi.advanceTimersByTimeAsync(4);
  await pending;
  expect(drained).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["close", "disconnect"])("cancels a stalled transport on %s", async (operation) => {
  vi.useFakeTimers();
  const { socket, writer } = fixture();
  const pending = writer.send(new Uint8Array(256))!;
  const rejected = expect(pending).rejects.toThrow("Relay disconnected");
  if (operation === "close") writer.close();
  else {
    socket.readyState = 3;
    await vi.advanceTimersByTimeAsync(4);
  }
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
