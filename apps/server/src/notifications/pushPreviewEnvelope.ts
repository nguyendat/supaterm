import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { ed25519 } from "@noble/curves/ed25519.js";
import type {
  PushDeliveryMetadata,
  PushPreviewContent,
  PushPreviewKey,
  PushPreviewEnvelope,
} from "@supacode/contracts/push";
import { decodeBase64, encodeBase64 } from "@supacode/shared/relay/protocol";
import {
  PUSH_PREVIEW_INFO,
  pushPreviewAssociatedData,
  pushPreviewSignatureData,
} from "@supacode/shared/pushPreviewEnvelope";

export const pushPreviewSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

export async function encryptPushPreview(
  signingSecret: Uint8Array,
  key: PushPreviewKey,
  metadata: PushDeliveryMetadata,
  content: PushPreviewContent,
): Promise<PushPreviewEnvelope> {
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(JSON.stringify(content));
  if (plaintext.byteLength > 768) throw new Error("Notification preview exceeds its byte budget.");
  const recipientPublicKey = await pushPreviewSuite.kem.deserializePublicKey(
    decodeBase64(key.publicKey),
  );
  const sender = await pushPreviewSuite.createSenderContext({
    recipientPublicKey,
    info: encoder.encode(PUSH_PREVIEW_INFO),
  });
  const ciphertext = await sender.seal(
    plaintext,
    encoder.encode(pushPreviewAssociatedData(metadata, key.keyId)),
  );
  const envelope = {
    version: 1 as const,
    keyId: key.keyId,
    enc: encodeBase64(new Uint8Array(sender.enc)),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
  return {
    ...envelope,
    signature: encodeBase64(
      ed25519.sign(encoder.encode(pushPreviewSignatureData(metadata, envelope)), signingSecret),
    ),
  };
}
