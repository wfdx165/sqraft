/**
 * 复制子树：id 重映射规则集中在这一处，UI（`⌘D`）、剪贴板粘贴、agent 的
 * `duplicate_node` 共用同一套计划与展开，避免三份各自推导"哪些字段引用了别的节点"。
 *
 * 确定性约束：新 id 必须在**命令创建之前**由调用方提供（`makeId`）；
 * 展开阶段只做纯计算，绝不调用 `newId()`。
 */
import type { Effect } from "./effects";
import { walkSubtree, type DocNode, type DocState, type Interaction, type NodeId, type NodeStyle } from "./model";
import type { Command } from "./store";

export interface DuplicateParams {
  /** 要复制的根节点（祖先与后代同时出现时由 `planDuplicate` 收成最外层） */
  nodeIds: NodeId[];
  /** 副本相对原件的位移，只作用于根节点 */
  dx: number;
  dy: number;
  /** 旧 id → 新 id，必须覆盖所有子树节点 */
  idMap: Record<NodeId, NodeId>;
}

export interface DuplicatePlan {
  command: Command;
  /** 副本的根节点 id（顺序与传入的根一致），用来把选区切到副本上 */
  rootIds: NodeId[];
}

/** 选区里同时包含祖先与后代时只保留最外层：复制父级自然带上子节点。 */
export function topLevelIds(doc: DocState, ids: readonly NodeId[]): NodeId[] {
  const set = new Set(ids);
  return [...set].filter((id) => {
    if (!doc.nodes[id]) return false;
    let cur = doc.nodes[id].parentId;
    while (cur) {
      if (set.has(cur)) return false;
      cur = doc.nodes[cur]?.parentId ?? null;
    }
    return true;
  });
}

/** 生成复制命令：先为整棵子树分配新 id，再交给命令展开。 */
export function planDuplicate(
  doc: DocState,
  ids: readonly NodeId[],
  options: { dx?: number; dy?: number; makeId: () => NodeId },
): DuplicatePlan {
  const roots = topLevelIds(doc, ids);
  const idMap: Record<NodeId, NodeId> = {};
  for (const root of roots) {
    walkSubtree(doc, root, (node) => {
      if (!idMap[node.id]) idMap[node.id] = options.makeId();
    });
  }
  return {
    command: {
      type: "node.duplicate",
      params: { nodeIds: roots, dx: options.dx ?? 10, dy: options.dy ?? 10, idMap },
    },
    rootIds: roots.map((id) => idMap[id]),
  };
}

/**
 * 展开成 `node.create`：每个根一条命令，副本插在原件**紧上方**。
 * 同一父级里有多个根时按原顺序依次插，避免两条命令的 index 互相顶掉。
 */
export function expandDuplicate(doc: DocState, params: DuplicateParams): Command[] {
  const roots = topLevelIds(doc, params.nodeIds);
  // 先按父级 + 原位置排序，插入位置才能算对
  const ordered = [...roots].sort((a, b) => {
    const na = doc.nodes[a];
    const nb = doc.nodes[b];
    if (!na || !nb) return 0;
    if (na.parentId !== nb.parentId) return (na.parentId ?? "").localeCompare(nb.parentId ?? "");
    return siblingIndex(doc, a) - siblingIndex(doc, b);
  });

  const inserted = new Map<string, number>();
  const out: Command[] = [];
  for (const rootId of ordered) {
    const root = doc.nodes[rootId];
    if (!root) throw new Error(`节点 ${rootId} 不存在`);
    const ids: NodeId[] = [];
    walkSubtree(doc, rootId, (node) => ids.push(node.id));
    for (const id of ids) {
      if (!params.idMap[id]) throw new Error(`复制缺少节点 ${id} 的新 id`);
    }
    const nodes = ids.map((id) => cloneNode(doc, id, params.idMap));
    // 位移只加在根上：子节点坐标是相对父级的局部坐标
    nodes[0].x += params.dx;
    nodes[0].y += params.dy;

    const key = root.parentId ?? "";
    const extra = inserted.get(key) ?? 0;
    inserted.set(key, extra + 1);
    out.push({
      type: "node.create",
      params: {
        nodes,
        parentId: root.parentId,
        // 页面根追加到末尾（apply 对 parentId 为 null 的情况不看 index）
        index: root.parentId ? siblingIndex(doc, rootId) + 1 + extra : undefined,
      },
    });
  }
  return out;
}

function siblingIndex(doc: DocState, id: NodeId): number {
  const node = doc.nodes[id];
  if (!node) return 0;
  const parent = node.parentId ? doc.nodes[node.parentId] : null;
  return parent ? parent.children.indexOf(id) : doc.rootIds.indexOf(id);
}

function cloneStyle(style: NodeStyle): NodeStyle {
  const next: NodeStyle = { ...style };
  if (style.fill) next.fill = { ...style.fill };
  if (style.stroke) next.stroke = { ...style.stroke };
  if (style.cornerRadius) next.cornerRadius = { ...style.cornerRadius };
  if (style.cornerRadiusTokens) next.cornerRadiusTokens = { ...style.cornerRadiusTokens };
  if (style.effects) next.effects = style.effects.map(cloneEffect);
  return next;
}

function cloneEffect(effect: Effect): Effect {
  if (effect.type === "drop-shadow" || effect.type === "inner-shadow") {
    return { ...effect, color: { ...effect.color } };
  }
  return { ...effect };
}

/**
 * 深拷贝一个节点并重映射所有"指向其他节点"的字段：
 * `parentId` / `children` / `componentId` / `mainId` / 属性定义的目标图层 /
 * 实例属性值里的节点引用 / 覆盖表的键。图片资源与 Token 引用按 id 共享，不复制。
 */
function cloneNode(doc: DocState, id: NodeId, idMap: Record<NodeId, NodeId>): DocNode {
  return remapNode(doc.nodes[id], idMap);
}

/**
 * 深拷贝一个节点并重映射所有"指向其他节点"的字段（导出给剪贴板用：
 * 粘贴的节点来自别的文档，不能从当前文档里查源节点）。
 */
export function remapNode(
  src: DocNode,
  idMap: Record<NodeId, NodeId>,
  options: { externalLinkTargets?: "keep" | "drop" } = {},
): DocNode {
  const remap = (ref: NodeId | null | undefined): NodeId | null => {
    if (!ref) return null;
    return idMap[ref] ?? ref;
  };
  const clone: DocNode = {
    ...src,
    id: idMap[src.id],
    parentId: remap(src.parentId),
    children: src.children.map((child) => idMap[child] ?? child),
    style: cloneStyle(src.style),
  };
  if (src.componentId) clone.componentId = remap(src.componentId) ?? src.componentId;
  if (src.mainId) clone.mainId = remap(src.mainId) ?? src.mainId;
  if (src.propertyDefs) {
    clone.propertyDefs = src.propertyDefs.map((def) => ({
      ...def,
      targetMainId: idMap[def.targetMainId] ?? def.targetMainId,
    }));
  }
  if (src.propValues) {
    const values: Record<string, string | boolean | NodeId> = {};
    for (const [key, value] of Object.entries(src.propValues)) {
      // 文本属性的值也是字符串，只有命中 idMap 的才是节点引用
      values[key] = typeof value === "string" ? (idMap[value] ?? value) : value;
    }
    clone.propValues = values;
  }
  if (src.overrides) {
    const overrides: DocNode["overrides"] = {};
    for (const [mainId, patch] of Object.entries(src.overrides)) {
      overrides[idMap[mainId] ?? mainId] = {
        ...patch,
        ...(patch.style ? { style: { ...patch.style } } : {}),
      };
    }
    clone.overrides = overrides;
  }
  if (src.image) clone.image = { ...src.image, ...(src.image.crop ? { crop: { ...src.image.crop } } : {}) };
  if (src.interactions?.length) {
    // 目标页可能不在复制范围内：同文档复制保留原目标，跨文档粘贴丢弃（"drop"）
    const kept: Interaction[] = [];
    for (const link of src.interactions) {
      const mapped = link.targetId ? idMap[link.targetId] : undefined;
      const targetId = mapped ?? (options.externalLinkTargets === "drop" ? undefined : link.targetId);
      if (link.action === "navigate" && !targetId) continue;
      kept.push({ ...link, targetId, transition: { ...link.transition } });
    }
    clone.interactions = kept.length ? kept : undefined;
  }
  if (src.vector) {
    clone.vector = { closed: src.vector.closed, anchors: src.vector.anchors.map((a) => ({ ...a })) };
  }
  if (src.layout) {
    clone.layout = { ...src.layout, padding: { ...src.layout.padding } };
  }
  return clone;
}
