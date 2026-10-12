import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { encodeBase64 } from "./relay/protocol.ts";

export function pushRequestHeaders(
  secret: Uint8Array,
  path: string,
  body: string,
  timestamp: number,
) {
  const encoder = new TextEncoder();
  const digest = bytesToHex(sha256(encoder.encode(body)));
  const message = encoder.encode(
    `supacode-push-request-v1\nPOST\n${path}\n${timestamp}\n${digest}`,
  );
  return {
    "content-type": "application/json",
    "x-supacode-host": encodeBase64(ed25519.getPublicKey(secret)),
    "x-supacode-timestamp": String(timestamp),
    "x-supacode-signature": encodeBase64(ed25519.sign(message, secret)),
  };
}
