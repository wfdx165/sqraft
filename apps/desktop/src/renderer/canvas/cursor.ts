/** 画布光标：由模式、工具与悬停状态推导。 */
import type { ResizeHandle } from "./selection";

export const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

export interface CursorState {
  mode: string;
  tool: string;
  dragging: boolean;
  hoverRotate: boolean;
  hoverHandle: ResizeHandle | null;
  hoverLabel: boolean;
  hoverText: boolean;
  hoverInactive: boolean;
}

/**
 * 旋转光标：24×24 的圆弧箭头，热点取中心。
 * 浏览器没有内置的 rotate 光标，用内联 SVG 免掉一个资源文件。
 */
const ROTATE_CURSOR = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M18.5 12a6.5 6.5 0 1 1-3.6-5.8" stroke="#fff" stroke-width="4.5"/>' +
    '<path d="M18.5 12a6.5 6.5 0 1 1-3.6-5.8" stroke="#1a1a1a" stroke-width="2"/>' +
    '<path d="M16.2 2.6 19.3 6.9l-4.7 1.1" stroke="#fff" stroke-width="4.5"/>' +
    '<path d="M16.2 2.6 19.3 6.9l-4.7 1.1" stroke="#1a1a1a" stroke-width="2"/>' +
    "</g></svg>",
)}") 12 12, crosshair`;

export function cursorFor(state: CursorState): string {
  if (state.mode === "pan") return state.dragging ? "grabbing" : "grab";
  if (state.tool !== "select") return "crosshair";
  // 角外旋转热区优先于缩放手柄（两者不重叠，这里只是让光标更稳）
  if (state.hoverRotate) return ROTATE_CURSOR;
  if (state.hoverHandle) return HANDLE_CURSORS[state.hoverHandle];
  if (state.hoverLabel) return "move";
  if (state.hoverText) return "text";
  if (state.hoverInactive) return "pointer";
  return "default";
}
