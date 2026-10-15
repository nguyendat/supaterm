import { requireOptionalNativeModule } from "expo";
import type { PushPreviewKey } from "@supaterm/contracts/push";

interface PushPreviewModule {
  ensure(environmentId: string): Promise<PushPreviewKey>;
  rotate(environmentId: string): Promise<PushPreviewKey>;
  bind(
    environmentId: string,
    recipientId: string,
    generation: number,
    hostSigningKey: string,
    enabled: boolean,
  ): Promise<void>;
  disable(recipientId: string): Promise<void>;
  remove(environmentId: string): Promise<void>;
}

export default requireOptionalNativeModule<PushPreviewModule>("SupacodePushPreview");
