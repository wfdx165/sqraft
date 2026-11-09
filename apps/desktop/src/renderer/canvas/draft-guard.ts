/**
 * 钢笔草稿的窗口级收尾：点击画布以外或窗口失焦时提交/结束当前草稿。
 */
import type { PenState } from "./pen";

export interface DraftGuards {
  onWindowPointerDown(e: PointerEvent): void;
  onWindowBlur(): void;
}

export function createDraftGuards(
  pen: PenState,
  canvas: () => HTMLCanvasElement | null,
  finish: () => void,
): DraftGuards {
  return {
    onWindowPointerDown(e: PointerEvent): void {
      if (!pen.draft) return;
      if (e.target === canvas()) return;
      finish();
    },
    onWindowBlur(): void {
      if (pen.draft) finish();
    },
  };
}
