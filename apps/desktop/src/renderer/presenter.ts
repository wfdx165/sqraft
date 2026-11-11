/**
 * 演示模式的状态机：进入 / 退出 / 跳转 / 返回 / 滚动钳制。
 *
 * 只碰 `ui.presenter`（纯 UI 状态）：不写文档、不进撤销、不动选区与缩放。
 * 渲染与输入在 `components/Presenter.vue`。
 */
import { subtreeWorldBounds, type DocNode, type NodeId } from "@sqraft/core";
import { docStore, ui } from "./store";

/** 演示起点：编辑模式取活动页，否则取选中的页面，再否则第一页。 */
export function presenterStartPage(): NodeId | null {
  const doc = docStore.doc;
  const isPage = (id: NodeId | null | undefined) => Boolean(id && doc.nodes[id]?.type === "page");
  if (ui.mode === "edit" && isPage(ui.activePageId)) return ui.activePageId;
  const selected = ui.selection.find(isPage);
  if (selected) return selected;
  return doc.rootIds.find(isPage) ?? null;
}

export function enterPresenter(pageId?: NodeId | null): void {
  const doc = docStore.doc;
  const target = pageId && doc.nodes[pageId]?.type === "page" ? pageId : presenterStartPage();
  if (!target) return;
  ui.presenter = { pageId: target, scroll: 0, stack: [] };
}

export function exitPresenter(): void {
  ui.presenter = null;
}

/** 演示中再次触发入口 = 退出。 */
export function togglePresenter(): void {
  if (ui.presenter) exitPresenter();
  else enterPresenter();
}

/** 跳到目标页：当前页与滚动位置入栈。 */
export function jumpTo(pageId: NodeId): void {
  const state = ui.presenter;
  if (!state) return;
  state.stack.push({ pageId: state.pageId, scroll: state.scroll });
  state.pageId = pageId;
  state.scroll = 0;
}

/** 返回上一屏；栈空返回 false（调用方决定要不要退出）。 */
export function goBack(): boolean {
  const state = ui.presenter;
  if (!state) return false;
  const prev = state.stack.pop();
  if (!prev) return false;
  state.pageId = prev.pageId;
  state.scroll = prev.scroll;
  return true;
}

/** 页面内容的可滚动范围（文档单位）：子节点包围盒并集超出页面的部分。 */
export function pageScrollRange(page: DocNode): number {
  const vertical = page.scrollDirection !== "horizontal";
  let extent = 0;
  for (const childId of page.children) {
    const box = subtreeWorldBounds(docStore.doc, childId);
    if (!box) continue;
    const end = vertical ? box.y + box.height - page.y : box.x + box.width - page.x;
    if (end > extent) extent = end;
  }
  const size = vertical ? page.height : page.width;
  return Math.max(0, Math.round(extent - size));
}

export function clampScroll(page: DocNode, value: number): number {
  return Math.min(Math.max(0, value), pageScrollRange(page));
}

/** 滚轮：横向页吃 dx，纵向页吃 dy（⇧ 把 dy 映射成 dx）。 */
export function scrollPresentPage(dx: number, dy: number): void {
  const state = ui.presenter;
  if (!state) return;
  const page = docStore.doc.nodes[state.pageId];
  if (!page || !page.scrollDirection || page.scrollDirection === "none") return;
  const delta = page.scrollDirection === "vertical" ? dy : dx;
  state.scroll = clampScroll(page, state.scroll + delta);
}
