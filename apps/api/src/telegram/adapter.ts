import type { BroadcastMaterial } from "../domain/broadcast-material.ts";
import type { TelegramDeliveryAdapter, TelegramDeliveryReceipt } from "../../../../packages/telegram-contract/src/index.ts";

export * from "../../../../packages/telegram-contract/src/index.ts";

export async function deliverBroadcastMaterial(adapter: TelegramDeliveryAdapter, targetRef: string, material: BroadcastMaterial): Promise<TelegramDeliveryReceipt> {
  if (material.kind === "TEXT") return adapter.sendText({ targetRef, text: material.text });
  return adapter.forwardNative({ targetRef, source: { channelUsername: material.source.channelUsername, messageId: material.source.messageId }, sourceAttribution: material.sourceAttribution });
}
