/**
 * 组件变体的界面动作：面板与检查器共用同一套命令入口。
 * 只生成 id 与拼命令，不直接改文档。
 */
import { newId, variantValuesOf, walkSubtree, type DocNode, type NodeId } from "@sqraft/core";
import { dispatch, docStore, select } from "./store";

export interface VariantSetView {
  set: DocNode;
  variants: Array<{ id: NodeId; name: string; values: string[] }>;
}

/** 当前文档里的组件集合（含每个变体的属性值），按根节点顺序。 */
export function variantSets(): VariantSetView[] {
  return docStore.doc.rootIds
    .map((id) => docStore.doc.nodes[id])
    .filter((node): node is DocNode => node?.type === "componentSet")
    .map((set) => ({
      set,
      variants: (set.children ?? [])
        .map((id) => docStore.doc.nodes[id])
        .filter((node): node is DocNode => node?.type === "component")
        .map((node) => ({
          id: node.id,
          name: node.name,
          values: variantValuesOf(docStore.doc, set, node.id) ?? [],
        })),
    }));
}

function uniqueValue(values: readonly string[], base: string): string {
  if (!values.includes(base)) return base;
  let i = 2;
  while (values.includes(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

/**
 * 复制一个变体并给最后一个属性一个新值（组合必然空闲）。
 * 之后用户在「管理变体属性」里把值改成真正想要的名字。
 */
export function duplicateVariant(setId: NodeId, sourceId: NodeId): NodeId | null {
  const set = docStore.doc.nodes[setId];
  if (!set || set.type !== "componentSet") return null;
  const defs = set.variantProperties ?? [];
  const source: DocNode | undefined = docStore.doc.nodes[sourceId];
  if (!source || source.type !== "component" || !defs.length) return null;
  const current = variantValuesOf(docStore.doc, set, sourceId);
  if (!current) return null;

  const index = defs.length - 1;
  const def = defs[index];
  const value = uniqueValue(def.values, current[index] ?? def.values[0] ?? "Variant");
  const values = Object.fromEntries(defs.map((entry, i) => [entry.id, i === index ? value : current[i]]));

  const idMap: Record<NodeId, NodeId> = {};
  walkSubtree(docStore.doc, sourceId, (node) => {
    idMap[node.id] = newId();
  });
  const componentId = idMap[sourceId];
  try {
    dispatch(
      {
        type: "variant.add",
        params: { setId, sourceComponentId: sourceId, values, componentId, idMap },
      },
      "variant-add",
    );
  } catch {
    return null;
  }
  select([componentId]);
  return componentId;
}

export function removeVariant(setId: NodeId, componentId: NodeId): boolean {
  try {
    dispatch({ type: "variant.remove", params: { setId, componentId } }, "variant-remove");
    return true;
  } catch {
    // 有实例引用时命令层会拒绝：界面保持原状，交给 toast / 检查器提示
    return false;
  }
}

/** 切换实例变体；非法组合由命令层兜底抛错。 */
export function setVariant(instanceId: NodeId, values: Record<string, string>): void {
  try {
    dispatch({ type: "variant.set", params: { instanceId, values } }, "variant-set");
  } catch {
    /* 不存在的组合不改文档 */
  }
}

/** 删除某个属性值：连带删除所有命中该值的变体（有实例引用会被整体拒绝）。 */
export function removeVariantValue(setId: NodeId, propertyId: string, value: string): boolean {
  const set = docStore.doc.nodes[setId];
  if (!set || set.type !== "componentSet") return false;
  try {
    dispatch({ type: "variant.removeValue", params: { setId, propertyId, value } }, "variant-remove");
    return true;
  } catch {
    return false;
  }
}
