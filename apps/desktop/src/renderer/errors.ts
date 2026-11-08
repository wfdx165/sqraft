/** 把核心抛出的 AppError 映射成文案；UI 跟随界面语言，MCP 固定英文。 */
import { AppError } from "@sqraft/core";
import { translate, type Locale, type MessageKey } from "../shared/i18n";
import { locale } from "./i18n";

const CODE_KEYS: Record<string, MessageKey> = {
  "core.group.empty": "core.group.empty",
  "core.group.crossPage": "core.group.crossPage",
  "core.group.root": "core.group.root",
  "core.ungroup.notGroup": "core.ungroup.notGroup",
  "core.ungroup.root": "core.ungroup.root",
  "core.distribute.needThree": "core.distribute.needThree",
  "core.arrange.autoLayout": "core.arrange.autoLayout",
  "core.token.samePath": "core.token.samePath",
  "core.token.missing": "core.token.missing",
  "core.token.exists": "core.token.exists",
  "core.slot.filled": "core.slot.filled",
  "core.slot.nameExists": "core.slot.nameExists",
  "core.slot.nested": "core.slot.nested",
  "core.slot.onlyContainer": "core.slot.onlyContainer",
  "core.slot.instanceInterior": "core.slot.instanceInterior",
  "core.slot.mustBeMain": "core.slot.mustBeMain",
  "core.slot.onlyInstance": "core.slot.onlyInstance",
  "core.component.missing": "core.component.missing",
};

/**
 * 识别 AppError。除了 `instanceof` 再做一次结构判断：
 * renderer / main / 独立包各有一份 core 时，跨 bundle 的 instanceof 会失效。
 */
function isAppError(error: unknown): error is AppError {
  if (error instanceof AppError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; params?: unknown };
  return candidate.name === "AppError" && typeof candidate.code === "string";
}

/** UI 错误文案：按指定/当前界面语言翻译；未知错误保留原始 message。 */
export function localizeError(error: unknown, target: Locale = locale.value): string {
  if (isAppError(error)) {
    const key = CODE_KEYS[error.code];
    return translate(target, key ?? "error.generic", error.params);
  }
  return error instanceof Error ? error.message : String(error);
}

/** agent 错误文案：固定英文，避免把 `core.*` 这种内部 code 直接丢给外部 agent。 */
export function agentErrorText(error: unknown): string {
  if (isAppError(error)) {
    const key = CODE_KEYS[error.code];
    if (key) return translate("en-US", key, error.params);
    return `Operation failed (${error.code}).`;
  }
  return error instanceof Error ? error.message : String(error);
}
