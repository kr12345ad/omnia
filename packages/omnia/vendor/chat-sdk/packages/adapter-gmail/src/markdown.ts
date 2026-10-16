import {
  BaseFormatConverter,
  type CardElement,
  paragraph,
  type Root,
  root,
  stringifyMarkdown,
  text,
} from "chat";
import { cardToGmailText } from "./cards";

export class GmailFormatConverter extends BaseFormatConverter {
  toAst(value: string): Root {
    return root([paragraph([text(value)])]);
  }

  fromAst(value: Root): string {
    return stringifyMarkdown(value).trimEnd();
  }

  protected override cardToFallbackText(card: CardElement): string {
    return cardToGmailText(card);
  }
}
