import { expect, it, vi } from "vite-plus/test";
import { createCanvasFrameSink } from "./frame.ts";

it("retains a borrowed frame at its native size before notifying the viewer", () => {
  const drawImage = vi.fn();
  const canvas = {
    width: 300,
    height: 150,
    getContext: () => ({ drawImage }),
  } as unknown as HTMLCanvasElement;
  const source = {} as CanvasImageSource;
  const notify = vi.fn(() => {
    expect(canvas.width).toBe(1170);
    expect(canvas.height).toBe(2532);
    expect(drawImage).toHaveBeenLastCalledWith(source, 0, 0, 1170, 2532);
  });
  createCanvasFrameSink(canvas, notify).present(source, 1170, 2532);
  expect(notify).toHaveBeenCalledOnce();
});

it("reports when a canvas cannot present a frame", () => {
  const canvas = {
    width: 300,
    height: 150,
    getContext: () => null,
  } as unknown as HTMLCanvasElement;
  const notify = vi.fn();
  expect(createCanvasFrameSink(canvas, notify).present({} as CanvasImageSource, 1170, 2532)).toBe(
    false,
  );
  expect(notify).not.toHaveBeenCalled();
});

it.each([
  [0, 800],
  [400, Number.NaN],
  [400.5, 800],
  [8193, 1],
  [8192, 8192],
])("rejects unsafe canvas dimensions %s by %s before allocating pixels", (width, height) => {
  const getContext = vi.fn();
  const canvas = { width: 300, height: 150, getContext } as unknown as HTMLCanvasElement;
  expect(createCanvasFrameSink(canvas).present({} as CanvasImageSource, width, height)).toBe(false);
  expect(getContext).not.toHaveBeenCalled();
  expect(canvas.width).toBe(300);
  expect(canvas.height).toBe(150);
});
