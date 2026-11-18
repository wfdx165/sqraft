/**
 * 画布渐变手柄的手势状态机：命中、拖拽预览、松手提交、取消。
 *
 * 只持有会话状态，不依赖 Vue：`CanvasView` 传进来 apply / markDirty / setDragging，
 * 拖拽过程只改预览，松手才落一条 `node.update`（一次拖动 = 一个撤销步）。
 */
import type { DocStore, GradientValue, NodeId } from "@sqraft/core";
import {
  GRADIENT_HANDLE_HIT_PX,
  GRADIENT_LINE_HIT_PX,
  dragGradientHandle,
  gradientFrameOf,
  hitGradientHandle,
  hitGradientLine,
  insertStopAt,
  removeStopAt,
  type GradientFrame,
  type GradientFrameOptions,
  type GradientHandleKind,
} from "./gradient-handles";

export interface GradientPoint {
  x: number;
  y: number;
}

export interface GradientGestureDeps {
  store: DocStore;
  /** 把渐变写回节点（整份 style 替换）。引用态会因此断链成本地渐变。 */
  apply: (nodeId: NodeId, kind: "fill" | "stroke", value: GradientValue, label: string) => void;
  markDirty: () => void;
  setDragging: (dragging: boolean) => void;
}

/** 指针按下被谁接走：手柄 / 渐变线（待插入色标）/ 没命中。 */
export type GradientGestureBegin = "handle" | "insert" | null;

export interface GradientGesture {
  /** 按下时命中手柄或渐变线；返回类型便于调用方决定是否吞掉这次按下 */
  begin(
    nodeId: NodeId,
    frame: GradientFrame,
    world: GradientPoint,
    screen: GradientPoint,
    pointerId: number,
    zoom: number,
    options?: { allowInsert?: boolean },
  ): GradientGestureBegin;
  move(world: GradientPoint, screen: GradientPoint, pointerId: number): void;
  end(screen: GradientPoint, pointerId: number): void;
  /** Esc / pointercancel：丢弃整次手势，不产生命令 */
  cancel(): void;
  isActive(): boolean;
  /** 绘制用：带拖拽预览的渐变框 */
  frameOf(nodeId: NodeId, options?: GradientFrameOptions): GradientFrame | null;
  /** 当前正在拖的手柄（高亮用） */
  activeHandle(): { kind: GradientHandleKind; index: number } | null;
  /** 双击色标删除；命中返回 true（少于 2 个色标时不删） */
  removeStop(nodeId: NodeId, world: GradientPoint, zoom: number): boolean;
}

interface DragSession {
  pointerId: number;
  nodeId: NodeId;
  kind: "fill" | "stroke";
  handle: GradientHandleKind;
  index: number;
  preview: GradientValue | null;
  moved: boolean;
  downX: number;
  downY: number;
}

interface InsertSession {
  pointerId: number;
  nodeId: NodeId;
  kind: "fill" | "stroke";
  t: number;
  downX: number;
  downY: number;
}

export function createGradientGesture(deps: GradientGestureDeps): GradientGesture {
  let drag: DragSession | null = null;
  let insert: InsertSession | null = null;

  return {
    begin(nodeId, frame, world, screen, pointerId, zoom, options) {
      const handle = hitGradientHandle(frame, world, GRADIENT_HANDLE_HIT_PX / zoom);
      if (handle) {
        drag = {
          pointerId,
          nodeId,
          kind: frame.kind,
          handle: handle.kind,
          index: handle.index,
          preview: null,
          moved: false,
          downX: screen.x,
          downY: screen.y,
        };
        deps.setDragging(true);
        deps.markDirty();
        return "handle";
      }
      if (options?.allowInsert === false) return null;
      const t = hitGradientLine(frame, world, GRADIENT_LINE_HIT_PX / zoom);
      if (t !== null) {
        insert = { pointerId, nodeId, kind: frame.kind, t, downX: screen.x, downY: screen.y };
        return "insert";
      }
      return null;
    },

    move(world, screen, pointerId) {
      if (!drag || drag.pointerId !== pointerId) return;
      if (!drag.moved && Math.hypot(screen.x - drag.downX, screen.y - drag.downY) < 2) return;
      drag.moved = true;
      // 每次都从文档里的原始值算：预览是"起点 + 当前指针"，不做增量累加
      const frame = gradientFrameOf(deps.store.doc, drag.nodeId);
      if (!frame) return;
      drag.preview = dragGradientHandle(frame, { kind: drag.handle, index: drag.index }, world);
      deps.markDirty();
    },

    end(screen, pointerId) {
      if (drag) {
        const session = drag;
        if (session.pointerId !== pointerId) return;
        drag = null;
        deps.setDragging(false);
        if (session.moved && session.preview) {
          deps.apply(session.nodeId, session.kind, session.preview, "渐变手柄");
        }
        deps.markDirty();
        return;
      }
      if (!insert) return;
      const pending = insert;
      if (pending.pointerId !== pointerId) return;
      insert = null;
      if (Math.hypot(screen.x - pending.downX, screen.y - pending.downY) <= 3) {
        const frame = gradientFrameOf(deps.store.doc, pending.nodeId);
        const added = frame ? insertStopAt(frame.value, pending.t) : null;
        if (added) deps.apply(pending.nodeId, pending.kind, added.value, "渐变色标");
      }
      deps.markDirty();
    },

    cancel() {
      if (!drag && !insert) return;
      drag = null;
      insert = null;
      deps.setDragging(false);
      deps.markDirty();
    },

    isActive() {
      return Boolean(drag || insert);
    },

    frameOf(nodeId, options) {
      const frame = gradientFrameOf(deps.store.doc, nodeId, options);
      if (!frame) return null;
      if (drag && drag.nodeId === nodeId && drag.preview) return { ...frame, value: drag.preview };
      return frame;
    },

    activeHandle() {
      return drag ? { kind: drag.handle, index: drag.index } : null;
    },

    removeStop(nodeId, world, zoom) {
      const frame = gradientFrameOf(deps.store.doc, nodeId);
      if (!frame) return false;
      const handle = hitGradientHandle(frame, world, GRADIENT_HANDLE_HIT_PX / zoom);
      if (handle?.kind !== "stop") return false;
      const next = removeStopAt(frame.value, handle.index);
      if (!next) return false;
      deps.apply(nodeId, frame.kind, next, "删除色标");
      return true;
    },
  };
}
