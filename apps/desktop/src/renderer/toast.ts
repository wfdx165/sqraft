/**
 * 轻量提示（toast）：只有一个实例，新的提示覆盖旧的并重置计时。
 * 用于"操作发生了但没有对话框"的反馈（例如复制为 PNG）。
 */
import { reactive } from "vue";

const VISIBLE_MS = 1600;

export const toastUi = reactive({
  message: "",
  tone: "info" as "info" | "error",
  visible: false,
});

let timer: ReturnType<typeof setTimeout> | null = null;

/** 显示一条提示；`error` 用警示色，内容相同也重新计时。 */
export function showToast(message: string, tone: "info" | "error" = "info"): void {
  toastUi.message = message;
  toastUi.tone = tone;
  toastUi.visible = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    toastUi.visible = false;
    timer = null;
  }, VISIBLE_MS);
}
