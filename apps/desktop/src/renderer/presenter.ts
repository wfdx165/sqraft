/**
 * 演示模式的状态机：进入 / 退出 / 跳转 / 返回 / 滚动钳制。
 *
 * 只碰 `ui.presenter`（纯 UI 状态）：不写文档、不进撤销、不动选区与缩放。
 * 渲染与输入在 `components/Presenter.vue`。
 */
import { subtreeWorldBounds, type DocNode, type NodeId } from "@sqraft/core";
import { logWarn } from "./log";
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

/** 演示模式状态机的返回栈上限：A↔B 互跳不该无限增长。 */
export const MAX_PRESENTER_STACK = 32;

/** 跳到目标页：当前页与滚动位置入栈。目标已不是页面（演示中被改稿）时忽略。 */
export function jumpTo(pageId: NodeId): void {
  const state = ui.presenter;
  if (!state) return;
  if (docStore.doc.nodes[pageId]?.type !== "page") return;
  state.stack.push({ pageId: state.pageId, scroll: state.scroll });
  // 超过上限丢最旧的一屏：用户仍然能按 ← 往回走，但栈不会无限长
  if (state.stack.length > MAX_PRESENTER_STACK) state.stack.shift();
  state.pageId = pageId;
  state.scroll = 0;
}

/** 返回上一屏；栈空（或栈里剩下的页都已被删）返回 false，调用方决定要不要退出。 */
export function goBack(): boolean {
  const state = ui.presenter;
  if (!state) return false;
  // 栈里的页面可能已经被删（演示中改稿、MCP 批量删页）：逐帧跳过，别落到空白页
  let skipped = 0;
  let landed = false;
  while (state.stack.length > 0) {
    const prev = state.stack.pop()!;
    if (docStore.doc.nodes[prev.pageId]?.type !== "page") {
      skipped += 1;
      continue;
    }
    state.pageId = prev.pageId;
    state.scroll = prev.scroll;
    landed = true;
    break;
  }
  // 正常后退不产生日志；只有跳过了已删页才留一条线索
  if (skipped > 0) logWarn("presenter/back skipped deleted pages", { count: skipped });
  return landed;
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
