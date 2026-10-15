import type { PushDeliveryMetadata, PushPreviewEnvelope } from "@supaterm/contracts/push";

export const PUSH_PREVIEW_INFO = "supacode-push-preview-hpke-v1";

export function pushPreviewAssociatedData(metadata: PushDeliveryMetadata, keyId: string): string {
  return [
    "supacode-push-preview-v1",
    "32:1:3",
    metadata.version,
    metadata.recipientId,
    metadata.generation,
    keyId,
    metadata.notificationId,
    metadata.createdAt,
    metadata.expiresAt,
  ].join("\n");
}

export function pushPreviewSignatureData(
  metadata: PushDeliveryMetadata,
  envelope: Pick<PushPreviewEnvelope, "keyId" | "enc" | "ciphertext">,
): string {
  return `supacode-push-preview-signature-v1\n${pushPreviewAssociatedData(metadata, envelope.keyId)}\n${envelope.enc}\n${envelope.ciphertext}`;
}
