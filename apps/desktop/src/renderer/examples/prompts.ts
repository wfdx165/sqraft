/**
 * 接入后的三条示例 prompt：正文固定英文（agent 侧表达稳定、便于回归），
 * 标题与说明走四语字典。
 */
import type { MessageKey } from "../../shared/i18n";

export interface ExamplePrompt {
  id: string;
  titleKey: MessageKey;
  descKey: MessageKey;
  text: string;
}

export const EXAMPLE_PROMPTS: readonly ExamplePrompt[] = [
  {
    id: "cards",
    titleKey: "onboarding.prompt.cards.title",
    descKey: "onboarding.prompt.cards.desc",
    text:
      'Create a 3-column card grid on the current page with `create_nodes`: each card has a title, a one-line summary, and a 48px-high rounded button. Use auto layout. When done, call `screenshot({format:"text"})` to check nothing overflows.',
  },
  {
    id: "tokens",
    titleKey: "onboarding.prompt.tokens.title",
    descKey: "onboarding.prompt.tokens.desc",
    text:
      "Call `define_token` to create a color token `color/action/primary`, then update the primary button to reference it with `fillToken` instead of a raw hex. Turn on strict mode and try writing a raw hex color — it should be rejected.",
  },
  {
    id: "diagnostics",
    titleKey: "onboarding.prompt.diagnostics.title",
    descKey: "onboarding.prompt.diagnostics.desc",
    text:
      'Read the current page, then fix every diagnostic in the response: zero-size nodes, text without fill, and text overflow. Re-run `screenshot({format:"text"})` when done.',
  },
];
