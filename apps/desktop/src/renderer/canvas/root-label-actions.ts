/**
 * 根节点名称标签的交互决策：命中、悬停态、右键菜单、按下 / 双击后的动作。
 *
 * 从 `CanvasView.vue` 抽出来的目的是让"母版不等于页面"这条规则能被单测覆盖：
 * 母版标签只改选区，绝不写 `activePageId` / `expandedPageId`。
 * 这里不持有任何手势状态，`drag` / `pageRename` 仍归画布组件。
 */
import type { DocNode, NodeId } from "@sqraft/core";
import type { Viewport } from "@sqraft/render";
import { select, ui } from "../store";
import { labelAt } from "./labels";

/** 指针下的根节点标签；钢笔草稿期间不认（画到页顶时别误拖整页）。 */
export function rootLabelAtPointer(
  vp: Viewport,
  ctx: CanvasRenderingContext2D | null,
  sx: number,
  sy: number,
  penDraft: boolean,
): DocNode | null {
  if (ui.tool === "path" && penDraft) return null;
  return labelAt(sx, sy, vp, ctx);
}

export interface RootLabelHover {
  /** 指针在标签上：显示 move 光标 */
  onLabel: boolean;
  /** 需要点亮紫色悬停框的库对象（母版标签优先于命中的图层） */
  libraryId: NodeId | null;
}

/** 悬停态：标签给 move 光标；母版标签还点亮它的紫色悬停框。 */
export function rootLabelHover(label: DocNode | null, hovered: DocNode | null): RootLabelHover {
  const libraryId =
    label?.type === "component"
      ? label.id
      : hovered && (hovered.type === "instance" || hovered.type === "component")
        ? hovered.id
        : null;
  return { onLabel: Boolean(label), libraryId };
}

/** 右键标签该弹哪套菜单：页面 → 页面菜单，母版 → 节点菜单。 */
export function rootLabelMenuKind(label: DocNode): "page" | "node" {
  return label.type === "page" ? "page" : "node";
}

/**
 * 按下标签：选中页面 / 母版。
 * 页面还要切活动页 + 展开左栏；母版不动页面状态——`activePageId` 写成母版 id
 * 会让后续"插实例 / 适配 / 图层过滤"全部跑到错的地方。
 */
export function beginRootLabelDrag(label: DocNode, deps: { setActivePage: (id: NodeId) => void }): void {
  if (label.type === "page") {
    if (label.id !== ui.activePageId) deps.setActivePage(label.id);
    ui.expandedPageId = label.id;
  }
  select([label.id]);
}

/** 双击标签：页面先切活动页，再进改名；母版只改名。 */
export function beginRootLabelRename(
  label: DocNode,
  deps: { setActivePage: (id: NodeId) => void; startRename: (node: DocNode) => void },
): void {
  if (label.type === "page" && label.id !== ui.activePageId) deps.setActivePage(label.id);
  deps.startRename(label);
}
