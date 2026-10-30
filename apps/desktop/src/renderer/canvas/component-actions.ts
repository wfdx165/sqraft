/** 组件相关的画布动作：插入实例、从选区创建组件、脱离实例。 */
import { createNode, type NodeId } from "@sqraft/core";
import { screenToWorld, type Viewport } from "@sqraft/render";
import { dispatch, docStore, select, switchMode, ui } from "../store";

export interface ComponentActionDeps {
  vp: Viewport;
  ensureActivePage: () => import("@sqraft/core").DocNode | null;
  markDirty: () => void;
}

/**
 * 把插入点夹回页面矩形。母版比页面还宽/高时上下界会反过来，
 * 这时直接取页面中心，别让实例跑到页面外。
 */
export function clampInstanceCenter(
  value: number,
  origin: number,
  side: number,
  size: number,
): number {
  const half = size / 2;
  const lo = origin + half;
  const hi = origin + side - half;
  if (lo > hi) return origin + side / 2;
  return Math.min(Math.max(value, lo), hi);
}

/**
 * 在活动页视口中心插入组件实例（组件面板与快捷键共用）。
 * 视口中心不落在活动页上时（比如刚飞到组件区看母版），夹回页面内，
 * 否则实例会建在页面外面，看起来像"消失了"。
 */
export function insertInstance(deps: ComponentActionDeps, componentId: NodeId): void {
  const master = docStore.doc.nodes[componentId];
  if (!master || master.type !== "component") return;
  switchMode("edit");
  const page = deps.ensureActivePage();
  if (!page) return;
  const w = screenToWorld(deps.vp, deps.vp.width / 2, deps.vp.height / 2);
  const halfW = master.width / 2;
  const halfH = master.height / 2;
  const cx = clampInstanceCenter(w.x, page.x, page.width, master.width);
  const cy = clampInstanceCenter(w.y, page.y, page.height, master.height);
  const id = createNode("instance").id;
  dispatch(
    {
      type: "instance.create",
      params: {
        componentId,
        parentId: page.id,
        nodeId: id,
        x: cx - page.x - halfW,
        y: cy - page.y - halfH,
      },
    },
    "insert-instance",
  );
  select([id]);
  ui.expandedPageId = page.id;
  deps.markDirty();
}

/** 创建组件：单容器原地转换/提升，其余选区自动包一层。 */
export function createComponentFromSelection(deps: ComponentActionDeps): void {
  if (ui.mode !== "edit") return;
  const ids = ui.selection.filter((id) => {
    const node = docStore.doc.nodes[id];
    return Boolean(node) && node.type !== "page";
  });
  if (ids.length === 0) return;
  const nodes = ids.map((id) => docStore.doc.nodes[id]);
  const singleContainer = nodes.length === 1 && (nodes[0].type === "frame" || nodes[0].type === "group");
  const componentId = singleContainer ? ids[0] : createNode("component").id;
  try {
    dispatch({ type: "component.create", params: { nodeIds: ids, componentId } }, "component");
  } catch {
    return;
  }
  select([componentId]);
  deps.markDirty();
}

/** 脱离当前选中的实例（快捷键与检查器共用）。 */
export function detachSelection(deps: ComponentActionDeps): void {
  if (ui.mode !== "edit" || ui.selection.length !== 1) return;
  const node = docStore.doc.nodes[ui.selection[0]];
  if (!node || node.type !== "instance") return;
  dispatch({ type: "component.detach", params: { instanceId: node.id } }, "detach");
  deps.markDirty();
}
