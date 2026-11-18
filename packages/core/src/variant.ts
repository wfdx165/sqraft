/**
 * 组件集合与枚举变体（ADR-0038）：纯规划函数 + 命令展开。
 *
 * 命令层只做校验与展开，不直接改文档；所有 id 由调用方在命令创建前生成，
 * 展开阶段只用已有 id，保证确定性。
 */
import {
  createLayoutSpec,
  createNode,
  walkSubtree,
  type DocNode,
  type DocState,
  type NodeId,
  type NodeOverride,
  type NodeStyle,
  type VariantPropertyDef,
} from "./model";
import { AppError } from "./errors";
import { remapNode } from "./duplicate";
import { planSwapInstanceClone, type SyncOp } from "./component";
import type { Command } from "./store";

/** 组合键分隔符：属性值里不允许出现。 */
export const VARIANT_KEY_SEP = "\u001f";

export function variantKey(values: readonly string[]): string {
  return values.join(VARIANT_KEY_SEP);
}

/** 组件集合的默认排布：横向 wrap、gap 24、padding 24。 */
export function variantSetLayout() {
  return createLayoutSpec({
    direction: "horizontal",
    wrap: true,
    gap: 24,
    crossGap: 24,
    padding: { top: 24, right: 24, bottom: 24, left: 24 },
  });
}

/** `Size=M, Type=Primary` → 属性名/值；格式不合法返回 null。 */
export function parseVariantName(name: string): { names: string[]; values: string[] } | null {
  const parts = name
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const names: string[] = [];
  const values: string[] = [];
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index <= 0) return null;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key || !value) return null;
    if (names.includes(key)) return null;
    names.push(key);
    values.push(value);
  }
  return { names, values };
}

export function variantDisplayName(defs: readonly VariantPropertyDef[], values: readonly string[]): string {
  return defs.map((def, i) => `${def.name}=${values[i] ?? ""}`).join(", ");
}

/** 组件所属的组件集合（沿祖先链找），没有则返回 null。 */
export function findComponentSet(state: DocState, componentId: NodeId): DocNode | null {
  let cur = state.nodes[componentId]?.parentId ?? null;
  while (cur) {
    const node = state.nodes[cur];
    if (!node) return null;
    if (node.type === "componentSet") return node;
    cur = node.parentId;
  }
  return null;
}

/** 变体当前属性值（按 `variantProperties` 顺序）；不在映射里返回 null。 */
export function variantValuesOf(state: DocState, set: DocNode, componentId: NodeId): string[] | null {
  const defs = set.variantProperties ?? [];
  for (const [key, id] of Object.entries(set.variantMap ?? {})) {
    if (id !== componentId) continue;
    const values = key.split(VARIANT_KEY_SEP);
    return values.length === defs.length ? values : null;
  }
  return null;
}

/** 变体名按 `Property=Value` 重新生成（只用于展示）。 */
export function variantNameFor(state: DocState, set: DocNode, componentId: NodeId): string | null {
  const defs = set.variantProperties ?? [];
  const values = variantValuesOf(state, set, componentId);
  return values ? variantDisplayName(defs, values) : null;
}

function uniqueSetName(state: DocState): string {
  const used = new Set(
    Object.values(state.nodes)
      .filter((n) => n.type === "componentSet")
      .map((n) => n.name),
  );
  let i = 1;
  while (used.has(`组件集合 ${i}`)) i += 1;
  return `组件集合 ${i}`;
}

function assertSet(state: DocState, setId: NodeId): DocNode {
  const set = state.nodes[setId];
  if (!set || set.type !== "componentSet") throw new Error("组件集合不存在");
  return set;
}

function assertNoValueSeparator(values: readonly string[], field: string): void {
  for (const value of values) {
    if (!value || value.includes(VARIANT_KEY_SEP) || value.includes(",")) {
      throw new Error(`${field} 不能为空、不能包含逗号或控制字符`);
    }
  }
}

/** 名称里解析出的属性必须与集合已有的定义一致（按名字对齐，顺序可以不同）。 */
function alignValues(defs: readonly VariantPropertyDef[], parsed: { names: string[]; values: string[] }): string[] {
  if (defs.length !== parsed.names.length) {
    throw new Error(
      `变体名与集合属性不一致：需要 ${defs.map((d) => `${d.name}=…`).join(", ") || "（无属性）"}`,
    );
  }
  return defs.map((def) => {
    const index = parsed.names.indexOf(def.name);
    if (index < 0) {
      throw new Error(`变体名缺少属性「${def.name}」`);
    }
    return parsed.values[index];
  });
}

/**
 * 组成集合：选中 2+ 个根级主组件，组件名必须是 `Property=Value` 形式且属性一致。
 * 集合用横向 wrap 自动布局，变体按选择顺序排进去。
 */
export function planVariantCombine(
  state: DocState,
  params: { nodeIds: NodeId[]; setId: NodeId },
): Command[] {
  const ids = [...new Set(params.nodeIds)];
  if (ids.length < 2) throw new Error("至少选择两个组件才能组成集合");
  if (state.nodes[params.setId]) throw new Error(`节点 ${params.setId} 已存在`);

  let defs: VariantPropertyDef[] | null = null;
  const parsed: Array<{ id: NodeId; values: string[] }> = [];
  const keys = new Set<string>();

  for (const id of ids) {
    const node = state.nodes[id];
    if (!node) throw new Error(`节点 ${id} 不存在`);
    if (node.type !== "component") throw new Error(`「${node.name}」不是主组件`);
    if (node.parentId !== null) throw new Error(`「${node.name}」必须位于组件区（文档根节点）`);
    const name = parseVariantName(node.name);
    if (!name) {
      throw new Error(`「${node.name}」的名字不是 Property=Value 形式，请先改名（例如 Size=M, Type=Primary）`);
    }
    assertNoValueSeparator(name.values, `「${node.name}」的变体值`);
    if (!defs) {
      defs = name.names.map((propertyName, i) => ({
        id: `prop-${i + 1}`,
        name: propertyName,
        values: [],
      }));
    }
    const values = alignValues(defs, name);
    const key = variantKey(values);
    if (keys.has(key)) throw new Error(`变体组合重复：${node.name}`);
    keys.add(key);
    values.forEach((value, i) => {
      const list = defs![i].values;
      if (!list.includes(value)) list.push(value);
    });
    parsed.push({ id, values });
  }

  const components = ids.map((id) => state.nodes[id]);
  const layout = variantSetLayout();
  const gap = layout.gap;
  const padding = layout.padding;
  const width =
    components.reduce((sum, node) => sum + node.width, 0) +
    gap * (components.length - 1) +
    padding.left +
    padding.right;
  const left = Math.min(...components.map((node) => node.x));
  const top = Math.min(...components.map((node) => node.y));

  const set = createNode("componentSet", {
    id: params.setId,
    name: uniqueSetName(state),
    parentId: null,
    x: left,
    y: top,
    width,
    height: Math.max(1, Math.max(...components.map((node) => node.height)) + padding.top + padding.bottom),
    clip: false,
    layoutSizingW: "fixed",
    layoutSizingH: "hug",
    layout,
    style: {},
    variantProperties: defs!,
    variantMap: Object.fromEntries(parsed.map((entry) => [variantKey(entry.values), entry.id])),
  });

  const out: Command[] = [{ type: "node.create", params: { nodes: [set], parentId: null } }];
  let cursor = padding.left;
  parsed.forEach((entry) => {
    out.push({
      type: "node.reparent",
      params: {
        nodeId: entry.id,
        parentId: set.id,
        x: cursor,
        y: padding.top,
      },
    });
    cursor += state.nodes[entry.id].width + gap;
    // 名称统一成解析后的规范写法（去掉多余空格）
    out.push({
      type: "node.update",
      params: { nodeId: entry.id, patch: { name: variantDisplayName(defs!, entry.values) } },
    });
  });
  return out;
}

/** 新变体的节点 id 必须在命令创建前全部生成（含整棵子树）。 */
export function planVariantAdd(
  state: DocState,
  params: {
    setId: NodeId;
    sourceComponentId: NodeId;
    values: Record<string, string>;
    componentId: NodeId;
    idMap: Record<NodeId, NodeId>;
  },
): Command[] {
  const set = assertSet(state, params.setId);
  const source = state.nodes[params.sourceComponentId];
  if (!source || source.type !== "component" || source.parentId !== set.id) {
    throw new Error("源变体必须属于该组件集合");
  }
  if (state.nodes[params.componentId]) throw new Error(`节点 ${params.componentId} 已存在`);

  const defs = set.variantProperties ?? [];
  if (defs.length === 0) throw new Error("组件集合还没有变体属性");
  let extended = false;
  const nextDefs = defs.map((def) => ({ ...def, values: [...def.values] }));
  const values = nextDefs.map((def) => {
    const value = params.values[def.id] ?? params.values[def.name];
    if (!value) throw new Error(`缺少属性「${def.name}」的值`);
    assertNoValueSeparator([value], `属性「${def.name}」的值`);
    // 显式新增变体时允许引入新值（不是"自动补变体"，是用户明确要求）
    if (!def.values.includes(value)) {
      def.values.push(value);
      extended = true;
    }
    return value;
  });
  const key = variantKey(values);
  if (set.variantMap?.[key]) throw new Error("该变体组合已存在");

  const ids: NodeId[] = [];
  walkSubtree(state, source.id, (node) => ids.push(node.id));
  for (const id of ids) {
    if (!params.idMap[id]) throw new Error(`复制缺少节点 ${id} 的新 id`);
  }
  const clones = ids.map((id) => {
    const clone = remapNode(state.nodes[id], params.idMap);
    if (id === source.id) {
      clone.parentId = set.id;
      clone.name = variantDisplayName(defs, values);
    }
    return clone;
  });

  return [
    {
      type: "node.create",
      params: { nodes: clones, parentId: set.id, index: set.children.length },
    },
    {
      type: "node.update",
      params: {
        nodeId: set.id,
        patch: {
          ...(extended ? { variantProperties: nextDefs } : {}),
          variantMap: { ...(set.variantMap ?? {}), [key]: params.componentId },
        },
      },
    },
  ];
}

/** 一个组件的图层名路径 → 母版节点 id（重名兄弟用 `#n` 区分）。 */
function pathIndex(state: DocState, componentId: NodeId): {
  byPath: Map<string, NodeId>;
  byId: Map<NodeId, string>;
} {
  const byPath = new Map<string, NodeId>();
  const byId = new Map<NodeId, string>();
  const visit = (nodeId: NodeId, prefix: string): void => {
    const node = state.nodes[nodeId];
    if (!node) return;
    const counts = new Map<string, number>();
    for (const childId of node.children) {
      const child = state.nodes[childId];
      if (!child) continue;
      const seen = counts.get(child.name) ?? 0;
      counts.set(child.name, seen + 1);
      const segment = seen === 0 ? child.name : `${child.name}#${seen}`;
      const path = prefix ? `${prefix}/${segment}` : segment;
      byPath.set(path, child.id);
      byId.set(child.id, path);
      visit(child.id, path);
    }
  };
  visit(componentId, "");
  return { byPath, byId };
}

function cloneOverride(patch: NodeOverride): NodeOverride {
  const next: NodeOverride = { ...patch };
  if (patch.style) next.style = { ...patch.style };
  for (const key of Object.keys(next)) {
    const value = (next as Record<string, unknown>)[key];
    if (value && typeof value === "object" && key !== "style") {
      (next as Record<string, unknown>)[key] = structuredClone(value);
    }
  }
  return next;
}

function applyOverride(node: DocNode, patch: NodeOverride | undefined): void {
  if (!patch) return;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "style") {
      node.style = { ...node.style, ...(value as Partial<NodeStyle>) };
      continue;
    }
    (node as unknown as Record<string, unknown>)[key] =
      value && typeof value === "object" ? structuredClone(value) : value;
  }
}

/**
 * 切换变体：几何不动，属性值按 id 保留，节点级覆盖按「图层名路径」匹配保留。
 * 在 `planSwapInstanceClone` 的基础上补齐保留规则。
 */
export function planVariantSwap(state: DocState, instance: DocNode, newComponentId: NodeId): SyncOp[] {
  const oldComponentId = instance.componentId;
  if (!oldComponentId) return [];
  const oldMaster = state.nodes[oldComponentId];
  const newMaster = state.nodes[newComponentId];
  if (!oldMaster || !newMaster) return [];

  const mapped: Record<NodeId, NodeOverride> = {};
  const oldPaths = pathIndex(state, oldComponentId);
  const newPaths = pathIndex(state, newComponentId);
  for (const [key, patch] of Object.entries(instance.overrides ?? {})) {
    let nextKey: NodeId | undefined;
    if (key === oldComponentId) nextKey = newComponentId;
    else {
      const path = oldPaths.byId.get(key);
      if (path) nextKey = newPaths.byPath.get(path);
    }
    if (nextKey) mapped[nextKey] = cloneOverride(patch);
  }

  const defs = newMaster.type === "component" ? (newMaster.propertyDefs ?? []) : [];
  const propValues: Record<string, string | boolean | NodeId> = {};
  for (const def of defs) {
    const value = instance.propValues?.[def.id];
    if (value === undefined) continue;
    if (def.type === "text" && typeof value === "string") propValues[def.id] = value;
    else if (def.type === "boolean" && typeof value === "boolean") propValues[def.id] = value;
  }

  const ops = planSwapInstanceClone(state, instance, newComponentId);
  if (ops.length === 0) return ops;

  for (const op of ops) {
    if (op.kind === "create") {
      for (const node of op.nodes) {
        const key = node.mainId ?? node.id;
        applyOverride(node, mapped[key]);
      }
      continue;
    }
    if (op.kind !== "update" || op.nodeId === instance.id) continue;
    // 复用的插槽节点：把覆盖直接并进它的更新补丁
    const key = op.patch.mainId;
    const override = key ? mapped[key] : undefined;
    if (!override) continue;
    for (const [field, value] of Object.entries(override)) {
      if (field === "style") {
        op.patch.style = { ...(op.patch.style ?? {}), ...(value as Partial<NodeStyle>) };
        continue;
      }
      (op.patch as Record<string, unknown>)[field] = value;
    }
  }

  // 文本/布尔属性值写回新建的克隆；实例替换属性涉及重建子树，先只保留同组件的值
  for (const def of defs) {
    if (def.type === "instance") {
      const value = instance.propValues?.[def.id];
      if (value !== undefined) {
        const target = ops
          .filter((op): op is Extract<SyncOp, { kind: "create" }> => op.kind === "create")
          .flatMap((op) => op.nodes)
          .find((node) => node.mainId === def.targetMainId);
        if (target && target.type === "instance" && target.componentId === value) propValues[def.id] = value;
      }
      continue;
    }
    const value = propValues[def.id];
    if (value === undefined) continue;
    const target = ops
      .filter((op): op is Extract<SyncOp, { kind: "create" }> => op.kind === "create")
      .flatMap((op) => op.nodes)
      .find((node) => node.mainId === def.targetMainId);
    if (!target) continue;
    if (def.type === "text") target.text = String(value);
    else target.visible = Boolean(value);
  }

  const root = ops.find(
    (op): op is Extract<SyncOp, { kind: "update" }> =>
      op.kind === "update" && op.nodeId === instance.id && op.patch.componentId === newComponentId,
  );
  if (root) {
    const patch = { ...root.patch };
    // 几何与可见性保留实例自己的
    for (const field of ["width", "height", "rotation", "opacity"] as const) delete patch[field];
    patch.componentId = newComponentId;
    if (instance.mainId === oldComponentId) patch.mainId = newComponentId;
    patch.propValues = Object.keys(propValues).length ? propValues : undefined;
    patch.overrides = Object.keys(mapped).length ? mapped : undefined;
    const rootOverride = mapped[newComponentId];
    if (rootOverride) {
      for (const [key, value] of Object.entries(rootOverride)) {
        if (key === "style") {
          patch.style = { ...(patch.style ?? {}), ...(value as Partial<NodeStyle>) };
          continue;
        }
        (patch as Record<string, unknown>)[key] = value;
      }
    }
    // 上面整体覆盖过属性/覆盖表，rootOverride 里不会再带它们；但保险起见再钉一次
    patch.propValues = Object.keys(propValues).length ? propValues : undefined;
    patch.overrides = Object.keys(mapped).length ? mapped : undefined;
    root.patch = patch;
  }

  return ops;
}

/** 切换实例变体：只允许已存在的组合，值可部分给（其余沿用当前变体）。 */
export function planVariantSet(
  state: DocState,
  params: { instanceId: NodeId; values: Record<string, string> },
): Command[] {
  const instance = state.nodes[params.instanceId];
  if (!instance || instance.type !== "instance" || !instance.componentId) throw new Error("实例不存在");
  const set = findComponentSet(state, instance.componentId);
  if (!set) throw new Error("该实例不属于组件集合");
  const defs = set.variantProperties ?? [];
  const current = variantValuesOf(state, set, instance.componentId);
  if (!current) throw new Error("实例当前变体不在集合映射里");

  const values = defs.map((def, i) => {
    const value = params.values[def.id] ?? params.values[def.name];
    return value ?? current[i];
  });
  for (const [i, value] of values.entries()) {
    if (!defs[i].values.includes(value)) throw new Error(`属性「${defs[i].name}」没有值「${value}」`);
  }
  const targetId = set.variantMap?.[variantKey(values)];
  if (!targetId) throw new Error("该属性组合没有对应变体");
  if (targetId === instance.componentId) return [];
  return planVariantSwap(state, instance, targetId).map((op) =>
    op.kind === "update"
      ? { type: "node.update", params: { nodeId: op.nodeId, patch: op.patch } }
      : op.kind === "create"
        ? { type: "node.create", params: { nodes: op.nodes, parentId: op.parentId } }
        : { type: "node.delete", params: { nodeId: op.nodeId } },
  );
}

/**
 * 管理变体属性：改名或重命名某个值，批量同步映射键与变体名。
 * 删除值请走 `planVariantRemove`（它要处理实例引用）。
 */
export function planVariantUpdateProperty(
  state: DocState,
  params: { setId: NodeId; propertyId: string; name?: string; renameValue?: { from: string; to: string } },
): Command[] {
  const set = assertSet(state, params.setId);
  const defs = set.variantProperties ?? [];
  const index = defs.findIndex((def) => def.id === params.propertyId);
  if (index < 0) throw new Error("变体属性不存在");

  const nextName = params.name?.trim();
  if (nextName !== undefined) {
    if (!nextName) throw new Error("属性名不能为空");
    if (defs.some((def) => def.id !== params.propertyId && def.name === nextName)) {
      throw new Error(`属性名「${nextName}」已存在`);
    }
  }

  const rename = params.renameValue;
  if (rename) {
    const def = defs[index];
    assertNoValueSeparator([rename.to], `「${def.name}」的值`);
    if (!def.values.includes(rename.from)) throw new Error(`值「${rename.from}」不存在`);
    if (rename.to !== rename.from && def.values.includes(rename.to)) {
      throw new Error(`值「${rename.to}」已存在`);
    }
  }
  if (nextName === undefined && !rename) return [];

  const nextDefs = defs.map((def, i) => {
    if (i !== index) return def;
    return {
      ...def,
      ...(nextName !== undefined ? { name: nextName } : {}),
      values: rename
        ? def.values.map((value) => (value === rename.from ? rename.to : value))
        : def.values,
    };
  });

  const nextMap: Record<string, NodeId> = {};
  const renames: Array<{ nodeId: NodeId; name: string }> = [];
  for (const [key, nodeId] of Object.entries(set.variantMap ?? {})) {
    const values = key.split(VARIANT_KEY_SEP);
    if (rename) {
      if (values[index] === rename.from) values[index] = rename.to;
    }
    const nextKey = variantKey(values);
    if (nextMap[nextKey]) throw new Error("重命名后会与已有变体组合冲突");
    nextMap[nextKey] = nodeId;
    if (state.nodes[nodeId]) {
      renames.push({ nodeId, name: variantDisplayName(nextDefs, values) });
    }
  }

  const out: Command[] = [
    {
      type: "node.update",
      params: { nodeId: set.id, patch: { variantProperties: nextDefs, variantMap: nextMap } },
    },
  ];
  for (const entry of renames) {
    out.push({ type: "node.update", params: { nodeId: entry.nodeId, patch: { name: entry.name } } });
  }
  return out;
}

/** 删除变体：有实例引用时拒绝（命令层校验，agent 也绕不过）。 */
export function planVariantRemove(state: DocState, params: { setId: NodeId; componentId: NodeId }): Command[] {
  const set = assertSet(state, params.setId);
  const node = state.nodes[params.componentId];
  if (!node || node.type !== "component" || node.parentId !== set.id) {
    throw new Error("变体不属于该组件集合");
  }
  const used = Object.values(state.nodes).some(
    (entry) => entry.type === "instance" && entry.componentId === params.componentId,
  );
  if (used) throw new AppError("core.variant.inUse", { name: node.name });

  const nextMap: Record<string, NodeId> = {};
  for (const [key, id] of Object.entries(set.variantMap ?? {})) {
    if (id !== params.componentId) nextMap[key] = id;
  }
  // 没有任何变体再使用的值从属性里摘掉（只剩空集合时保留原定义）
  const nextDefs = pruneVariantValues(set.variantProperties ?? [], nextMap);
  return [
    {
      type: "node.update",
      params: {
        nodeId: set.id,
        patch: { variantMap: nextMap, ...(nextDefs ? { variantProperties: nextDefs } : {}) },
      },
    },
    { type: "node.delete", params: { nodeId: params.componentId } },
  ];
}

/** 映射里不再出现的值从属性列表里删掉；全部变体都没了则保留原定义。 */
function pruneVariantValues(
  defs: VariantPropertyDef[],
  map: Record<string, NodeId>,
): VariantPropertyDef[] | null {
  if (!defs.length || Object.keys(map).length === 0) return null;
  const used = defs.map(() => new Set<string>());
  for (const key of Object.keys(map)) {
    key.split(VARIANT_KEY_SEP).forEach((value, i) => used[i]?.add(value));
  }
  return defs.map((def, i) => {
    const values = def.values.filter((value) => used[i].has(value));
    return values.length === def.values.length ? def : { ...def, values };
  });
}

/**
 * 删除某个属性值：连带删除所有命中该值的变体。
 * 必须一条命令，否则多条 node.update 各自按旧映射重算会互相覆盖。
 */
export function planVariantRemoveValue(
  state: DocState,
  params: { setId: NodeId; propertyId: string; value: string },
): Command[] {
  const set = assertSet(state, params.setId);
  const defs = set.variantProperties ?? [];
  const index = defs.findIndex((def) => def.id === params.propertyId);
  if (index < 0) throw new Error("变体属性不存在");
  const targets: NodeId[] = [];
  for (const [key, id] of Object.entries(set.variantMap ?? {})) {
    if (key.split(VARIANT_KEY_SEP)[index] === params.value) targets.push(id);
  }
  if (!targets.length) throw new Error("没有使用该值的变体");

  for (const id of targets) {
    const node = state.nodes[id];
    const used = Object.values(state.nodes).some(
      (entry) => entry.type === "instance" && entry.componentId === id,
    );
    if (used) throw new AppError("core.variant.inUse", { name: node?.name ?? id });
  }

  const nextMap: Record<string, NodeId> = {};
  for (const [key, id] of Object.entries(set.variantMap ?? {})) {
    if (!targets.includes(id)) nextMap[key] = id;
  }
  const nextDefs = defs.map((def, i) =>
    i === index ? { ...def, values: def.values.filter((value) => value !== params.value) } : def,
  );
  const pruned = pruneVariantValues(nextDefs, nextMap);
  const out: Command[] = [
    {
      type: "node.update",
      params: {
        nodeId: set.id,
        patch: { variantMap: nextMap, variantProperties: pruned ?? nextDefs },
      },
    },
  ];
  for (const id of targets) out.push({ type: "node.delete", params: { nodeId: id } });
  return out;
}
