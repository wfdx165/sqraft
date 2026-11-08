/**
 * 钢笔与锚点编辑的会话状态与逻辑（纯 UI 状态，不进文档、不进撤销）。
 * 状态放在一个可变对象里，由 CanvasView 持有；函数显式接收所需依赖，便于阅读与后续拆分。
 */

import type { DocStore, NodeId, VectorAnchor, VectorPath } from "@sqraft/core";
import { createNode, makeAnchor, worldRect } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import type { Command } from "@sqraft/core";
import { t } from "../i18n";

export interface PenDraft {
  pageId: NodeId;
  anchors: VectorAnchor[];
}

export interface PathEdit {
  id: NodeId;
  active: number;
}

export interface VectorDrag {
  pointerId: number;
  kind: "anchor" | "handle";
  index: number;
  side?: "in" | "out";
  /** 拖动开始时的锚点（世界坐标），提交时换算回本地坐标 */
  startAnchors: VectorAnchor[];
  startWX: number;
  startWY: number;
  moved: boolean;
  preview: VectorPath | null;
}

export interface PenState {
  draft: PenDraft | null;
  /** 钢笔光标（世界坐标），用于橡皮筋预览与首锚吸附高亮 */
  penHover: { x: number; y: number } | null;
  pathEdit: PathEdit | null;
  vectorDrag: VectorDrag | null;
}

export function createPenState(): PenState {
  return { draft: null, penHover: null, pathEdit: null, vectorDrag: null };
}

export interface PenDeps {
  docStore: DocStore;
  ui: { mode: string; tool: string; selection: NodeId[] };
  dispatch: (cmd: Command | Command[], label?: string) => void;
  select: (ids: NodeId[]) => void;
  markDirty: () => void;
}

/** 路径默认名：路径 N（同类节点内不重复）。 */
export function nextPathName(docStore: DocStore): string {
  const base = t("node.path");
  const used = new Set(
    Object.values(docStore.doc.nodes)
      .filter((n) => n.type === "path")
      .map((n) => n.name),
  );
  let i = 1;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

/** 多边形默认名：sides=3 叫三角形，其余叫多边形，各自编号。 */
export function nextPolygonName(docStore: DocStore, sides: number): string {
  const base = sides === 3 ? t("node.triangle") : t("node.polygon");
  const used = new Set(
    Object.values(docStore.doc.nodes)
      .filter((n) => n.type === "polygon" && n.name.startsWith(base))
      .map((n) => n.name),
  );
  let i = 1;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

/** 提交草稿：去重后一次性建节点（撤销一步删整条）。 */
export function finishDraft(pen: PenState, deps: PenDeps, closed: boolean): void {
  const d = pen.draft;
  pen.draft = null;
  pen.penHover = null;
  if (!d) return;
  const anchors: VectorAnchor[] = [];
  for (const a of d.anchors) {
    const prev = anchors[anchors.length - 1];
    if (prev && Math.hypot(prev.x - a.x, prev.y - a.y) <= 0.5) continue;
    anchors.push({ ...a });
  }
  if (closed && anchors.length >= 3) {
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= 0.5) anchors.pop();
  }
  if (anchors.length < 2) {
    deps.markDirty();
    return;
  }
  const page = deps.docStore.doc.nodes[d.pageId];
  if (!page) {
    deps.markDirty();
    return;
  }
  const close = closed && anchors.length >= 3;
  const node = createNode("path", {
    name: nextPathName(deps.docStore),
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    vector: {
      closed: close,
      anchors: anchors.map((a) => ({ ...a, x: a.x - page.x, y: a.y - page.y })),
    },
    style: close
      ? { fill: { value: "#3366ff" } }
      : { stroke: { value: "#1a1a1a" }, strokeWidth: 2 },
  });
  deps.dispatch({ type: "node.create", params: { nodes: [node], parentId: d.pageId } }, "pen");
  // 切到拖动模式时不要回填选区（模式切换已经清空选区）
  if (deps.ui.mode === "edit") {
    deps.ui.tool = "select";
    deps.select([node.id]);
  }
  deps.markDirty();
}

/** 草稿期撤销：只回退最后一个锚点，不触碰文档撤销栈。 */
export function removeDraftAnchor(pen: PenState, deps: PenDeps): void {
  if (!pen.draft) return;
  pen.draft.anchors.pop();
  if (pen.draft.anchors.length === 0) pen.draft = null;
  deps.markDirty();
}

/** 锚点编辑态的命中：先当前锚点的手柄，再所有锚点（屏幕 6px）。 */
export function pathAnchorAt(
  pen: PenState,
  deps: Pick<PenDeps, "docStore">,
  vp: Viewport,
  sx: number,
  sy: number,
): { index: number; side?: "in" | "out" } | null {
  if (!pen.pathEdit) return null;
  const node = deps.docStore.doc.nodes[pen.pathEdit.id];
  const origin = worldRect(deps.docStore.doc, pen.pathEdit.id);
  if (!node?.vector || !origin) return null;
  const anchors = node.vector.anchors;
  const active = Math.max(0, Math.min(pen.pathEdit.active, anchors.length - 1));
  const a = anchors[active];
  if (a) {
    for (const side of ["in", "out"] as const) {
      const hx = side === "in" ? a.inX : a.outX;
      const hy = side === "in" ? a.inY : a.outY;
      if (!hx && !hy) continue;
      const p = worldToScreen(vp, origin.x + a.x + hx, origin.y + a.y + hy);
      if (Math.hypot(p.x - sx, p.y - sy) <= 6) return { index: active, side };
    }
  }
  for (let i = 0; i < anchors.length; i++) {
    const p = worldToScreen(vp, origin.x + anchors[i].x, origin.y + anchors[i].y);
    if (Math.hypot(p.x - sx, p.y - sy) <= 6) return { index: i };
  }
  return null;
}

/** 切到钢笔后的一次点击：开始新草稿（调用方保证落在页面内）。 */
export function beginDraft(pen: PenState, pageId: NodeId, wx: number, wy: number): void {
  pen.draft = { pageId, anchors: [makeAnchor(wx, wy)] };
  pen.penHover = { x: wx, y: wy };
}
