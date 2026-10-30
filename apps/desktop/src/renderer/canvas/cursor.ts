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
  hoverHandle: ResizeHandle | null;
  hoverLabel: boolean;
  hoverText: boolean;
  hoverInactive: boolean;
}

export function cursorFor(state: CursorState): string {
  if (state.mode === "pan") return state.dragging ? "grabbing" : "grab";
  if (state.tool !== "select") return "crosshair";
  if (state.hoverHandle) return HANDLE_CURSORS[state.hoverHandle];
  if (state.hoverLabel) return "move";
  if (state.hoverText) return "text";
  if (state.hoverInactive) return "pointer";
  return "default";
}
