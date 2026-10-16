import { cardToFallbackText } from "@chat-adapter/shared";
import type { CardElement } from "chat";

export function cardToGmailText(card: CardElement): string {
  return cardToFallbackText(card, { boldFormat: "**", lineBreak: "\n" });
}
