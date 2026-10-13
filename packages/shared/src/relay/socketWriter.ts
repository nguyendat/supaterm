import type { WebSocketLike } from "effect/socket/Socket";
import { every } from "./timer.ts";

export type BufferedWebSocket = WebSocketLike & { readonly bufferedAmount: number };

export function createSocketWriter(socket: BufferedWebSocket, limit: number) {
  let cancel: (() => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  return {
    send(message: Uint8Array<ArrayBuffer>): void | Promise<void> {
      if (socket.readyState !== 1) throw new Error("Relay disconnected");
      socket.send(message);
      if (socket.bufferedAmount < limit) return;
      return new Promise<void>((resolve, reject) => {
        fail = reject;
        cancel = every(4, () => {
          if (socket.readyState === 1 && socket.bufferedAmount > limit / 4) return;
          cancel?.();
          cancel = undefined;
          fail = undefined;
          if (socket.readyState === 1) resolve();
          else reject(new Error("Relay disconnected"));
        });
      });
    },
    close(error = new Error("Relay disconnected")) {
      cancel?.();
      cancel = undefined;
      fail?.(error);
      fail = undefined;
    },
  };
}
