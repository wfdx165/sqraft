/** 组件相关的画布动作：插入实例、从选区创建组件、脱离实例。 */
import { createNode, type NodeId } from "@sqraft/core";
import { screenToWorld, type Viewport } from "@sqraft/render";
import { dispatch, docStore, select, switchMode, ui } from "../store";

export interface ComponentActionDeps {
  vp: Viewport;
  ensureActivePage: () => import("@sqraft/core").DocNode | null;
  markDirty: () => void;
}

/** 在活动页视口中心插入组件实例（组件面板与快捷键共用）。 */
export function insertInstance(deps: ComponentActionDeps, componentId: NodeId): void {
  const master = docStore.doc.nodes[componentId];
  if (!master || master.type !== "component") return;
  switchMode("edit");
  const page = deps.ensureActivePage();
  if (!page) return;
  const w = screenToWorld(deps.vp, deps.vp.width / 2, deps.vp.height / 2);
  const id = createNode("instance").id;
  dispatch(
    {
      type: "instance.create",
      params: {
        componentId,
        parentId: page.id,
        nodeId: id,
        x: w.x - page.x - master.width / 2,
        y: w.y - page.y - master.height / 2,
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
