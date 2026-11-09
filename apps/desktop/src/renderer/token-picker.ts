/**
 * 数值 Token 选择器：检查器里的「绑定」按钮共用一个浮层。
 * 纯 UI 状态，不写文档；真正的绑定由调用方的 onPick 决定。
 */
import { reactive } from "vue";

export const tokenPicker = reactive({
  open: false,
  x: 0,
  y: 0,
  /** 当前绑定的 Token 路径；空串表示未绑定 */
  current: "",
  onPick: (_path: string | null) => {},
});

export function openTokenPicker(options: {
  x: number;
  y: number;
  current?: string;
  onPick: (path: string | null) => void;
}): void {
  tokenPicker.open = true;
  tokenPicker.x = Math.round(options.x);
  tokenPicker.y = Math.round(options.y);
  tokenPicker.current = options.current ?? "";
  tokenPicker.onPick = options.onPick;
}

export function closeTokenPicker(): void {
  if (!tokenPicker.open) return;
  tokenPicker.open = false;
}

/** 选中/解绑后先关浮层，再执行绑定（绑定可能触发重绘/重排）。 */
export function pickToken(path: string | null): void {
  const handler = tokenPicker.onPick;
  closeTokenPicker();
  handler(path);
}
