import { expect, it } from "vite-plus/test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  PushDeliveryMetadata,
  PushPreviewContent,
  PushPreviewEnvelope,
} from "@supacode/contracts/push";
import { encodeBase64, decodeBase64 } from "@supacode/shared/relay/protocol";
import {
  PUSH_PREVIEW_INFO,
  pushPreviewAssociatedData,
  pushPreviewSignatureData,
} from "@supacode/shared/pushPreviewEnvelope";
import * as Schema from "effect/Schema";
import testVectors from "../../../mobile/modules/supacode-push-preview/Tests/PushPreviewCoreTests/vectors.json" with { type: "json" };

import { encryptPushPreview, pushPreviewSuite } from "./pushPreviewEnvelope.ts";
import { pushPreviewContent } from "./pushPreviewContent.ts";

const vectors = Schema.decodeUnknownSync(
  Schema.Struct({
    supacode: Schema.Struct({
      payload: Schema.Struct({ ...PushDeliveryMetadata.fields, preview: PushPreviewEnvelope }),
      binding: Schema.Struct({ privateKey: Schema.String, hostSigningKey: Schema.String }),
      content: PushPreviewContent,
    }),
    rfc9180: Schema.Struct({
      info: Schema.String,
      privateKey: Schema.String,
      enc: Schema.String,
      encryptions: Schema.Array(
        Schema.Struct({ aad: Schema.String, ct: Schema.String, pt: Schema.String }),
      ),
    }),
  }),
)(testVectors);
const encoder = new TextEncoder();
const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

it("opens the RFC 9180 messages in sequence with the maintained HPKE implementation", async () => {
  const vector = vectors.rfc9180;
  const recipientKey = await pushPreviewSuite.kem.deserializePrivateKey(hex(vector.privateKey));
  const recipient = await pushPreviewSuite.createRecipientContext({
    recipientKey,
    enc: hex(vector.enc),
    info: hex(vector.info),
  });
  for (const entry of vector.encryptions) {
    expect(new Uint8Array(await recipient.open(hex(entry.ct), hex(entry.aad)))).toEqual(
      hex(entry.pt),
    );
  }
});

it("authenticates the same envelope and plaintext as CryptoKit", async () => {
  const { payload, binding, content } = vectors.supacode;
  const recipientKey = await pushPreviewSuite.kem.deserializePrivateKey(
    decodeBase64(binding.privateKey),
  );
  const recipient = await pushPreviewSuite.createRecipientContext({
    recipientKey,
    enc: decodeBase64(payload.preview.enc),
    info: encoder.encode(PUSH_PREVIEW_INFO),
  });
  const plaintext = await recipient.open(
    decodeBase64(payload.preview.ciphertext),
    encoder.encode(pushPreviewAssociatedData(payload, payload.preview.keyId)),
  );
  expect(new TextDecoder().decode(plaintext)).toBe(JSON.stringify(content));
  expect(
    ed25519.verify(
      decodeBase64(payload.preview.signature),
      encoder.encode(pushPreviewSignatureData(payload, payload.preview)),
      decodeBase64(binding.hostSigningKey),
    ),
  ).toBe(true);
  expect(
    ed25519.verify(
      decodeBase64(payload.preview.signature),
      encoder.encode(
        pushPreviewSignatureData({ ...payload, expiresAt: payload.expiresAt + 1 }, payload.preview),
      ),
      decodeBase64(binding.hostSigningKey),
    ),
  ).toBe(false);
});

it("encrypts independently per device and rejects a different recipient or associated data", async () => {
  const secret = new Uint8Array(32).fill(1);
  const keyId = vectors.supacode.payload.preview.keyId;
  const privateA = new Uint8Array(32).fill(2);
  const privateB = new Uint8Array(32).fill(3);
  const metadata = vectors.supacode.payload;
  const first = await encryptPushPreview(
    secret,
    { keyId, publicKey: encodeBase64(x25519.getPublicKey(privateA)) },
    metadata,
    vectors.supacode.content,
  );
  const second = await encryptPushPreview(
    secret,
    { keyId, publicKey: encodeBase64(x25519.getPublicKey(privateB)) },
    metadata,
    vectors.supacode.content,
  );
  expect(first.ciphertext).not.toBe(second.ciphertext);
  const wrongKey = await pushPreviewSuite.kem.deserializePrivateKey(privateB);
  const wrong = await pushPreviewSuite.createRecipientContext({
    recipientKey: wrongKey,
    enc: decodeBase64(first.enc),
    info: encoder.encode(PUSH_PREVIEW_INFO),
  });
  await expect(
    wrong.open(
      decodeBase64(first.ciphertext),
      encoder.encode(pushPreviewAssociatedData(metadata, keyId)),
    ),
  ).rejects.toThrow();
  const ownKey = await pushPreviewSuite.kem.deserializePrivateKey(privateA);
  const changed = await pushPreviewSuite.createRecipientContext({
    recipientKey: ownKey,
    enc: decodeBase64(first.enc),
    info: encoder.encode(PUSH_PREVIEW_INFO),
  });
  await expect(
    changed.open(
      decodeBase64(first.ciphertext),
      encoder.encode(
        pushPreviewAssociatedData({ ...metadata, generation: metadata.generation + 1 }, keyId),
      ),
    ),
  ).rejects.toThrow();
});

it("bounds escaped and multibyte previews before encryption", () => {
  const content = pushPreviewContent(
    {
      title: "🔐".repeat(500),
      latestVisibleMessage: { role: "assistant", text: '\\"'.repeat(1000) },
    },
    "completion",
  );
  expect(encoder.encode(JSON.stringify(content)).byteLength).toBeLessThanOrEqual(768);
  expect(content.title).not.toContain("�");
  expect(content.body).toContain("Thread completed");
});
