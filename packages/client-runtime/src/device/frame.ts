/** A synchronous, borrowed frame. The producer releases its source after present returns. */
export interface DeviceFrameSink {
  readonly present: (source: CanvasImageSource, width: number, height: number) => boolean;
}

export const isDeviceFrameSize = (width: number, height: number) =>
  Number.isInteger(width) &&
  Number.isInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= 8192 &&
  height <= 8192 &&
  width * height <= 16_777_216;

/** Retains the latest frame in a canvas; consumers can invalidate textures after each draw. */
export function createCanvasFrameSink(
  canvas: HTMLCanvasElement,
  onFrame?: (width: number, height: number) => void,
): DeviceFrameSink {
  return {
    present(source, width, height) {
      if (!isDeviceFrameSize(width, height)) return false;
      const context = canvas.getContext("2d");
      if (!context) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(source, 0, 0, width, height);
      onFrame?.(width, height);
      return true;
    },
  };
}
