/**
 * 组件/实例的纯函数：命名、依赖判断、实例物化。
 * 命令层只调用这里的纯逻辑；物化 id 由「实例 id + 母版节点 id」确定性派生，
 * 因此同步时不需要在 apply 执行期生成新 id。
 */

import { createNode, type DocNode, type DocState, type NodeOverride, type NodeStyle, type NodeId } from "./model";

/** 主组件默认名：「组件 N」，全文档不重复。 */
export function nextComponentName(state: DocState): string {
  const used = new Set(
    Object.values(state.nodes)
      .filter((n) => n.type === "component")
      .map((n) => n.name),
  );
  let i = 1;
  while (used.has(`组件 ${i}`)) i += 1;
  return `组件 ${i}`;
}

/**
 * 节点在“当前母版”里的稳定身份：
 * - 实例节点用自身 id（同一组件可以有多个实例）；
 * - 其它克隆节点沿用 mainId（指回组件母版里的节点），避免 id 里重复叠加实例 id。
 */
export function nodeKey(node: DocNode): NodeId {
  return node.type === "instance" ? node.id : (node.mainId ?? node.id);
}

function cloneStyle(style: NodeStyle): NodeStyle {
  return {
    ...style,
    fill: style.fill ? { ...style.fill } : style.fill,
    stroke: style.stroke ? { ...style.stroke } : style.stroke,
  };
}

/** 深拷贝节点数据（style / vector / layout / 实例覆盖），但保留 id/父子关系由调用方决定。 */
function cloneNodeData(node: DocNode): DocNode {
  const copy: DocNode = {
    ...node,
    children: [],
    style: cloneStyle(node.style),
    vector: node.vector
      ? { closed: node.vector.closed, anchors: node.vector.anchors.map((a) => ({ ...a })) }
      : undefined,
    layout: node.layout ? { ...node.layout } : undefined,
    propValues: node.propValues ? { ...node.propValues } : undefined,
    overrides: node.overrides ? structuredClone(node.overrides) : undefined,
  };
  return copy;
}

/**
 * 物化实例：返回实例根与全部子孙（前序）。
 * 子孙 id = `${父节点 id}:${母版节点 id}`；同一实例重复物化结果稳定。
 */
export function materializeInstance(
  state: DocState,
  componentId: NodeId,
  instanceId: NodeId,
  parentId: NodeId,
  x: number,
  y: number,
  name?: string,
): DocNode[] {
  const master = state.nodes[componentId];
  if (!master || master.type !== "component") {
    throw new Error(`组件 ${componentId} 不存在`);
  }

  const out: DocNode[] = [];
  const root = createNode("instance", {
    id: instanceId,
    name: name ?? master.name,
    parentId,
    x,
    y,
    width: master.width,
    height: master.height,
    rotation: master.rotation,
    // 母版自身是否隐藏只影响它在画布上的呈现，不传播给实例
    visible: true,
    locked: false,
    style: cloneStyle(master.style),
    layout: master.layout ? { ...master.layout } : undefined,
    componentId,
    mainId: componentId,
  });
  out.push(root);

  const cloneChildren = (source: DocNode, cloneParent: DocNode): void => {
    for (const childId of source.children) {
      const child = state.nodes[childId];
      if (!child) continue;
      const key = nodeKey(child);
      const cloneId = `${cloneParent.id}:${key}`;
      const clone = createNode(child.type, {
        ...cloneNodeData(child),
        id: cloneId,
        parentId: cloneParent.id,
        // 身份键（嵌套克隆会沿用组件母版节点 id）；嵌套实例自身的 componentId 保持不变
        mainId: key,
        children: [],
      });
      cloneParent.children.push(cloneId);
      out.push(clone);
      cloneChildren(child, clone);
    }
  };
  cloneChildren(master, root);

  return out;
}

/** 节点祖先链上出现的组件 id（直接组件节点或实例引用的组件）。 */
function componentIdsInChain(state: DocState, nodeId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  let cur: DocNode | undefined = state.nodes[nodeId];
  while (cur) {
    if (cur.type === "component") out.push(cur.id);
    if (cur.type === "instance" && cur.componentId) out.push(cur.componentId);
    cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
  }
  return out;
}

/** from 组件（含其内部实例链）是否依赖 target 组件。 */
function componentDependsOn(
  state: DocState,
  from: NodeId,
  target: NodeId,
  seen = new Set<NodeId>(),
): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const master = state.nodes[from];
  if (!master) return false;
  const stack = [...master.children];
  while (stack.length) {
    const node = state.nodes[stack.pop()!];
    if (!node) continue;
    if (node.type === "instance" && node.componentId) {
      if (componentDependsOn(state, node.componentId, target, seen)) return true;
    }
    stack.push(...node.children);
  }
  return false;
}

/** 把 componentId 的实例插到 parentId 下是否会形成自引用/循环。 */
export function wouldCreateComponentCycle(
  state: DocState,
  componentId: NodeId,
  parentId: NodeId,
): boolean {
  for (const target of componentIdsInChain(state, parentId)) {
    if (target === componentId) return true;
    if (componentDependsOn(state, componentId, target)) return true;
  }
  return false;
}

/* ---------- 同步：母版 → 实例 ---------- */

export type SyncOp =
  | { kind: "update"; nodeId: NodeId; patch: Partial<DocNode> }
  | { kind: "create"; nodes: DocNode[]; parentId: NodeId }
  | { kind: "delete"; nodeId: NodeId };

function applyOverride(node: DocNode, override: NodeOverride | undefined): void {
  if (!override) return;
  for (const [key, value] of Object.entries(override)) {
    if (key === "style") {
      node.style = { ...node.style, ...(value as Partial<NodeStyle>) };
      continue;
    }
    // 对象字段深拷贝，避免实例与覆盖表共享引用
    (node as unknown as Record<string, unknown>)[key] =
      value && typeof value === "object" ? structuredClone(value) : value;
  }
}

/** 从母版节点生成一个实例子树（含覆盖），id 由父节点 id 派生。 */
function buildCloneSubtree(
  state: DocState,
  masterNode: DocNode,
  parentId: NodeId,
  overrides: Record<NodeId, NodeOverride>,
): DocNode[] {
  const key = nodeKey(masterNode);
  const id = `${parentId}:${key}`;
  const clone = createNode(masterNode.type, {
    ...cloneNodeData(masterNode),
    id,
    parentId,
    mainId: key,
    children: [],
  });
  applyOverride(clone, overrides[key]);
  const out: DocNode[] = [clone];
  for (const childId of masterNode.children) {
    const child = state.nodes[childId];
    if (child) out.push(...buildCloneSubtree(state, child, id, overrides));
  }
  return out;
}

/** 插槽清空后要重建的默认内容：每个母版子节点一棵独立子树（各自作为 node.create 的根）。 */
export function buildSlotDefaultRoots(
  state: DocState,
  slotCloneId: NodeId,
  masterSlot: DocNode,
): DocNode[][] {
  const out: DocNode[][] = [];
  for (const childId of masterSlot.children) {
    const child = state.nodes[childId];
    if (child) out.push(buildCloneSubtree(state, child, slotCloneId, {}));
  }
  return out;
}

/** 属性值 → 目标节点的强制字段（属性优先于母版与覆盖）。 */
export function propBindings(state: DocState, instance: DocNode): Map<NodeId, Partial<DocNode>> {
  const out = new Map<NodeId, Partial<DocNode>>();
  const component = instance.componentId ? state.nodes[instance.componentId] : undefined;
  if (!component || component.type !== "component") return out;
  for (const def of component.propertyDefs ?? []) {
    const value = instance.propValues?.[def.id];
    if (value === undefined) continue;
    const current = out.get(def.targetMainId) ?? {};
    if (def.type === "text") out.set(def.targetMainId, { ...current, text: String(value) });
    else if (def.type === "boolean") out.set(def.targetMainId, { ...current, visible: Boolean(value) });
    else out.set(def.targetMainId, { ...current, componentId: value as NodeId });
  }
  return out;
}

/**
 * 把一个嵌套实例换成另一个组件：保留 id/位置/mainId，尺寸与样式取新组件，
 * 旧内容和旧覆盖清空（08 会在此基础上补保留规则）。
 */
export function planSwapInstanceClone(state: DocState, instance: DocNode, newComponentId: NodeId): SyncOp[] {
  const master = state.nodes[newComponentId];
  if (!master || master.type !== "component") return [];
  const topLevel = instance.mainId === instance.componentId;
  const ops: SyncOp[] = [
    {
      kind: "update",
      nodeId: instance.id,
      patch: {
        componentId: newComponentId,
        ...(topLevel ? { mainId: newComponentId } : {}),
        width: master.width,
        height: master.height,
        rotation: master.rotation,
        style: cloneStyle(master.style),
        layout: master.layout ? { ...master.layout } : undefined,
        name: master.name,
        propValues: undefined,
        overrides: undefined,
      },
    },
  ];

  // 同名且已填充的顶层插槽：保留用户内容，复用槽节点
  const oldFilledSlots = new Map<string, DocNode>();
  for (const childId of instance.children) {
    const child = state.nodes[childId];
    if (child?.type === "slot" && child.slotFilled) oldFilledSlots.set(child.name, child);
  }
  const reuse = new Set<NodeId>();
  const desired: NodeId[] = [];
  for (const childId of master.children) {
    const child = state.nodes[childId];
    if (!child) continue;
    const key = nodeKey(child);
    if (child.type === "slot") {
      const old = oldFilledSlots.get(child.name);
      if (old) {
        ops.push({
          kind: "update",
          nodeId: old.id,
          patch: {
            mainId: child.id,
            name: child.name,
            x: child.x,
            y: child.y,
            width: child.width,
            height: child.height,
            rotation: child.rotation,
            visible: child.visible,
            locked: child.locked,
            style: cloneStyle(child.style),
            layout: child.layout ? { ...child.layout } : undefined,
            slotFilled: true,
          },
        });
        desired.push(old.id);
        reuse.add(old.id);
        continue;
      }
    }
    ops.push({ kind: "create", nodes: buildCloneSubtree(state, child, instance.id, {}), parentId: instance.id });
    desired.push(`${instance.id}:${key}`);
  }

  for (const childId of instance.children) {
    if (!reuse.has(childId)) ops.push({ kind: "delete", nodeId: childId });
  }
  ops.push({ kind: "update", nodeId: instance.id, patch: { children: desired } });
  return ops;
}

/** 新建克隆时把文本/可见性的属性值直接写进去；componentId 不支持（子树仍来自旧组件）。 */
function applyForced(node: DocNode, forced: Partial<DocNode> | undefined): void {
  if (!forced) return;
  if ("text" in forced) node.text = forced.text;
  if ("visible" in forced) node.visible = Boolean(forced.visible);
}

/**
 * 对比母版与实例节点，产出最小字段补丁。
 * 覆盖先叠加到母版值上；isRoot 时位置、名称、可见性属于实例自身，不跟随母版。
 */
function diffNode(
  source: DocNode,
  target: DocNode,
  override: NodeOverride | undefined,
  isRoot: boolean,
  forced?: Partial<DocNode>,
): Partial<DocNode> {
  const patch: Partial<DocNode> = {};
  const pick = <K extends keyof DocNode>(key: K): DocNode[K] => {
    if (forced && key in forced) return (forced as Record<string, unknown>)[key as string] as DocNode[K];
    if (override && key in override) return (override as Record<string, unknown>)[key as string] as DocNode[K];
    return source[key];
  };
  const set = (key: keyof DocNode, value: unknown): void => {
    if (JSON.stringify(value) === JSON.stringify(target[key])) return;
    (patch as Record<string, unknown>)[key] = value;
  };

  const style: NodeStyle = { ...source.style, ...(override?.style ?? {}) };
  set("style", style);
  set("width", pick("width"));
  set("height", pick("height"));
  set("rotation", pick("rotation"));
  set("name", pick("name"));
  if (isRoot && forced && "visible" in forced) set("visible", forced.visible);
  if (!isRoot) {
    set("type", pick("type"));
    set("x", pick("x"));
    set("y", pick("y"));
    set("visible", pick("visible"));
    set("locked", pick("locked"));
  }
  set("text", pick("text"));
  set("sides", pick("sides"));
  const vector = pick("vector");
  set("vector", vector ? structuredClone(vector) : undefined);
  const layout = pick("layout");
  set("layout", layout ? { ...layout } : undefined);
  if (!isRoot) {
    if (source.type === "instance") {
      set("componentId", pick("componentId"));
      const propValues = pick("propValues");
      set("propValues", propValues ? structuredClone(propValues) : undefined);
    } else if (target.componentId !== undefined) {
      set("componentId", undefined);
    }
  }
  return patch;
}

/** 递归规划一组克隆子节点的同步操作。 */
function planChildren(
  state: DocState,
  masterParent: DocNode,
  cloneParent: DocNode,
  overrides: Record<NodeId, NodeOverride>,
  props: Map<NodeId, Partial<DocNode>>,
  ops: SyncOp[],
  deadOverrides: Set<NodeId>,
): void {
  const existing = new Map<NodeId, DocNode>();
  for (const childId of cloneParent.children) {
    const child = state.nodes[childId];
    if (child?.mainId) existing.set(child.mainId, child);
  }

  const desired: NodeId[] = [];
  const alive = new Set<NodeId>();
  for (const masterChildId of masterParent.children) {
    const masterChild = state.nodes[masterChildId];
    if (!masterChild) continue;
    const key = nodeKey(masterChild);
    alive.add(key);
    const found = existing.get(key);
    const forced = props.get(key);
    if (found) {
      if (found.type === "instance") {
        const outer = overrides[key] ?? {};
        const fallback = masterChild.type === "instance" ? masterChild.componentId : undefined;
        const forcedId = forced && "componentId" in forced ? (forced.componentId as NodeId | undefined) : undefined;
        const targetComponentId = forcedId ?? (outer.componentId as NodeId | undefined) ?? fallback;

        if (targetComponentId && found.componentId !== targetComponentId) {
          // 换组件：重建子树，之后不再按母版递归
          ops.push(...planSwapInstanceClone(state, found, targetComponentId));
          desired.push(found.id);
          continue;
        }

        if (targetComponentId && targetComponentId !== fallback) {
          // 已替换到别的组件：外层只同步位置/可见性，自身字段与子树归自己的组件同步
          const patch: Partial<DocNode> = {};
          for (const field of ["x", "y", "visible", "locked"] as const) {
            const value = (outer as Record<string, unknown>)[field] ?? masterChild[field];
            if (JSON.stringify(value) !== JSON.stringify(found[field])) {
              (patch as Record<string, unknown>)[field] = value;
            }
          }
          if (Object.keys(patch).length) ops.push({ kind: "update", nodeId: found.id, patch });
          desired.push(found.id);
          continue;
        }

        // 正常嵌套实例：自身字段用自身覆盖，外层字段用外层覆盖
        const self = found.overrides?.[found.componentId ?? ""] ?? {};
        const merged: NodeOverride = { ...self, ...outer };
        const patch = diffNode(masterChild, found, merged, false, forced);
        if (Object.keys(patch).length) ops.push({ kind: "update", nodeId: found.id, patch });
        desired.push(found.id);

        const effective = { ...found, propValues: merged.propValues ?? masterChild.propValues };
        const deadSelf = new Set<NodeId>();
        planChildren(state, masterChild, found, found.overrides ?? {}, propBindings(state, effective), ops, deadSelf);
        if (deadSelf.size > 0) {
          const next = { ...(found.overrides ?? {}) };
          for (const deadKey of deadSelf) delete next[deadKey];
          ops.push({
            kind: "update",
            nodeId: found.id,
            patch: { overrides: Object.keys(next).length ? next : undefined },
          });
        }
        continue;
      }

      const patch = diffNode(masterChild, found, overrides[key], false, forced);
      if (Object.keys(patch).length) ops.push({ kind: "update", nodeId: found.id, patch });
      desired.push(found.id);
      // 已填充插槽的内容归实例所有：只同步槽节点自身，不碰内容
      const filledSlot = masterChild.type === "slot" && found.type === "slot" && found.slotFilled;
      if (!filledSlot) planChildren(state, masterChild, found, overrides, props, ops, deadOverrides);
    } else {
      const nodes = buildCloneSubtree(state, masterChild, cloneParent.id, overrides);
      applyForced(nodes[0], forced);
      ops.push({ kind: "create", nodes, parentId: cloneParent.id });
      desired.push(`${cloneParent.id}:${key}`);
    }
  }

  for (const [mainId, node] of existing) {
    if (alive.has(mainId)) continue;
    ops.push({ kind: "delete", nodeId: node.id });
    deadOverrides.add(mainId);
  }

  if (cloneParent.children.join("|") !== desired.join("|")) {
    ops.push({ kind: "update", nodeId: cloneParent.id, patch: { children: desired } });
  }
}

/** 规划一个实例相对其主组件需要执行的全部同步操作。 */
export function planInstanceSync(state: DocState, instanceId: NodeId): SyncOp[] {
  const instance = state.nodes[instanceId];
  if (!instance || instance.type !== "instance" || !instance.componentId) return [];
  const master = state.nodes[instance.componentId];
  if (!master || master.type !== "component") return [];

  const ops: SyncOp[] = [];
  const overrides: Record<NodeId, NodeOverride> = { ...(instance.overrides ?? {}) };
  const props = propBindings(state, instance);
  const dead = new Set<NodeId>();
  planChildren(state, master, instance, overrides, props, ops, dead);

  // 母版里已删除的节点：清掉它们的覆盖，避免覆盖表越积越脏
  for (const key of Object.keys(overrides)) {
    if (!state.nodes[key]) dead.add(key);
  }
  for (const key of dead) delete overrides[key];

  const rootPatch = diffNode(master, instance, overrides[nodeKey(master)], true, props.get(nodeKey(master)));
  if (dead.size > 0 || instance.overrides) {
    if (JSON.stringify(overrides) !== JSON.stringify(instance.overrides ?? {})) {
      rootPatch.overrides = overrides;
    }
  }
  if (Object.keys(rootPatch).length) ops.unshift({ kind: "update", nodeId: instance.id, patch: rootPatch });
  return ops;
}

/** 组件依赖顺序：被依赖的组件排在前面（A 里放 B 的实例 → B 在 A 前）。 */
export function componentOrder(state: DocState): NodeId[] {
  const all = Object.values(state.nodes)
    .filter((n) => n.type === "component")
    .map((n) => n.id)
    .sort();
  const deps = new Map<NodeId, NodeId[]>();
  for (const id of all) {
    const master = state.nodes[id];
    const found = new Set<NodeId>();
    if (master) {
      const stack = [...master.children];
      while (stack.length) {
        const node = state.nodes[stack.pop()!];
        if (!node) continue;
        if (node.type === "instance" && node.componentId && node.componentId !== id) found.add(node.componentId);
        stack.push(...node.children);
      }
    }
    deps.set(id, [...found].sort());
  }

  const out: NodeId[] = [];
  const mark = new Map<NodeId, "temp" | "done">();
  const visit = (id: NodeId): void => {
    const m = mark.get(id);
    if (m === "done") return;
    if (m === "temp") return; // 循环在命令层已被拒绝，这里只防御
    mark.set(id, "temp");
    for (const dep of deps.get(id) ?? []) visit(dep);
    mark.set(id, "done");
    out.push(id);
  };
  for (const id of all) visit(id);
  return out;
}

/* ---------- 覆盖：记录、查询、重置 ---------- */

export interface OverrideOwner {
  /** 拥有覆盖表的实例（最近的实例祖先，或节点自身） */
  owner: DocNode;
  /** 覆盖表键：实例根 = componentId，克隆节点 = mainId */
  key: NodeId;
  /** 对应的母版节点 */
  master: DocNode;
}

/** 找到节点所属的实例与母版；不在实例里返回 null。 */
export function findOverrideOwner(state: DocState, nodeId: NodeId): OverrideOwner | null {
  const node = state.nodes[nodeId];
  if (!node) return null;
  if (node.type === "instance" && node.componentId) {
    const master = state.nodes[node.componentId];
    if (master?.type === "component") return { owner: node, key: node.componentId, master };
  }
  let cur = node.parentId ? state.nodes[node.parentId] : undefined;
  while (cur) {
    if (cur.type === "instance" && cur.componentId) {
      const key = node.type === "instance" ? node.componentId : node.mainId;
      if (!key) return null;
      const master = state.nodes[key];
      if (!master) return null;
      return { owner: cur, key, master };
    }
    cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
  }
  return null;
}

/** 找到节点的最近实例祖先（不含节点自身）。 */
export function findInstanceAncestor(state: DocState, nodeId: NodeId): DocNode | null {
  let cur = state.nodes[nodeId]?.parentId;
  while (cur) {
    const node = state.nodes[cur];
    if (!node) return null;
    if (node.type === "instance") return node;
    cur = node.parentId;
  }
  return null;
}

/** 嵌套实例的「外层」覆盖表：位置、可见性、组件指向、外层属性值。 */
export function findOuterOverrideOwner(state: DocState, nodeId: NodeId): OverrideOwner | null {
  const node = state.nodes[nodeId];
  if (!node || node.type !== "instance" || !node.mainId) return null;
  const ancestor = findInstanceAncestor(state, nodeId);
  if (!ancestor) return null;
  const master = state.nodes[node.mainId];
  if (!master) return null;
  return { owner: ancestor, key: node.mainId, master };
}

/** 当前节点自己的覆盖补丁（不含祖先的）。 */
export function overridePatchOf(state: DocState, nodeId: NodeId): NodeOverride | null {
  const info = findOverrideOwner(state, nodeId);
  if (!info) return null;
  return info.owner.overrides?.[info.key] ?? null;
}

/** 嵌套实例的外层覆盖补丁。 */
export function outerOverridePatchOf(state: DocState, nodeId: NodeId): NodeOverride | null {
  const info = findOuterOverrideOwner(state, nodeId);
  if (!info) return null;
  return info.owner.overrides?.[info.key] ?? null;
}

function cloneValue<T>(value: T): T {
  return value && typeof value === "object" ? structuredClone(value) : value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 属性绑定的字段不能写覆盖：属性优先。 */
function boundFields(state: DocState, owner: DocNode, key: NodeId): Set<string> {
  const component = owner.componentId ? state.nodes[owner.componentId] : undefined;
  const out = new Set<string>();
  for (const def of component?.propertyDefs ?? []) {
    if (def.targetMainId !== key) continue;
    out.add(def.type === "text" ? "text" : def.type === "boolean" ? "visible" : "componentId");
  }
  return out;
}

/**
 * 实例根相对自己组件根的差异（自身作用域）。
 * 位置、可见性、锁定、componentId 不属于自身覆盖。
 */
export function computeSelfOverride(state: DocState, nodeId: NodeId): NodeOverride | null {
  const node = state.nodes[nodeId];
  if (!node || node.type !== "instance" || !node.componentId) return null;
  const master = state.nodes[node.componentId];
  if (!master || master.type !== "component") return null;
  const patch: NodeOverride = {};
  for (const field of ["name", "width", "height", "rotation", "layout"] as const) {
    if (!sameValue(node[field], master[field])) (patch as Record<string, unknown>)[field] = cloneValue(node[field]);
  }
  const stylePatch: Partial<NodeStyle> = {};
  for (const sk of new Set([...Object.keys(node.style), ...Object.keys(master.style)])) {
    const a = (node.style as Record<string, unknown>)[sk];
    const b = (master.style as Record<string, unknown>)[sk];
    if (!sameValue(a, b)) (stylePatch as Record<string, unknown>)[sk] = cloneValue(a);
  }
  if (Object.keys(stylePatch).length) patch.style = stylePatch;
  return Object.keys(patch).length ? patch : null;
}

/** 嵌套实例相对外层母版子节点的差异（外层作用域）。 */
export function computeOuterOverride(state: DocState, nodeId: NodeId): NodeOverride | null {
  const node = state.nodes[nodeId];
  if (!node || node.type !== "instance") return null;
  const info = findOuterOverrideOwner(state, nodeId);
  if (!info) return null;
  const bound = boundFields(state, info.owner, info.key);
  const patch: NodeOverride = {};
  for (const field of ["x", "y", "visible", "locked", "componentId"] as const) {
    if (bound.has(field)) continue;
    if (!sameValue(node[field], info.master[field])) (patch as Record<string, unknown>)[field] = cloneValue(node[field]);
  }
  // 仍指向同一个组件时，属性值是外层母版的一部分；已替换后归实例自己
  if (node.componentId === info.master.componentId && !sameValue(node.propValues, info.master.propValues)) {
    patch.propValues = cloneValue(node.propValues);
  }
  return Object.keys(patch).length ? patch : null;
}

/** 非实例克隆相对母版的字段级差异；实例节点走自身作用域。 */
export function computeOverridePatch(state: DocState, nodeId: NodeId): NodeOverride | null {
  const node = state.nodes[nodeId];
  if (!node) return null;
  if (node.type === "instance") return computeSelfOverride(state, nodeId);
  const info = findOverrideOwner(state, nodeId);
  if (!info) return null;
  const bound = boundFields(state, info.owner, info.key);
  const patch: NodeOverride = {};
  const fields: Array<keyof DocNode> = [
    "name", "x", "y", "width", "height", "rotation", "visible", "locked", "text", "sides", "vector", "layout",
  ];
  for (const field of fields) {
    if (bound.has(field)) continue;
    if (!sameValue(node[field], info.master[field])) {
      (patch as Record<string, unknown>)[field] = cloneValue(node[field]);
    }
  }
  const stylePatch: Partial<NodeStyle> = {};
  for (const sk of new Set([...Object.keys(node.style), ...Object.keys(info.master.style)])) {
    const a = (node.style as Record<string, unknown>)[sk];
    const b = (info.master.style as Record<string, unknown>)[sk];
    if (!sameValue(a, b)) (stylePatch as Record<string, unknown>)[sk] = cloneValue(a);
  }
  if (Object.keys(stylePatch).length) patch.style = stylePatch;
  return Object.keys(patch).length ? patch : null;
}

/** 在实例子树里按覆盖键找节点（实例根用 componentId 作为键）。 */
export function findInstanceNodeByKey(state: DocState, owner: DocNode, key: NodeId): DocNode | null {
  if (owner.componentId === key) return owner;
  const stack = [...owner.children];
  while (stack.length) {
    const node = state.nodes[stack.pop()!];
    if (!node) continue;
    if (node.mainId === key) return node;
    stack.push(...node.children);
  }
  return null;
}

export interface OverrideResetPlan {
  ops: Array<{ nodeId: NodeId; patch: Partial<DocNode> }>;
  /** componentId 不能只写字段：必须按目标组件重建子树 */
  swaps: Array<{ nodeId: NodeId; componentId: NodeId }>;
}

/**
 * 规划「重置覆盖」要写回的字段值。
 * 实例根按自身组件恢复；嵌套实例按外层/自身作用域分别恢复；componentId 重置转为换组件。
 */
export function planOverrideReset(
  state: DocState,
  instanceId: NodeId,
  key?: NodeId,
  fields?: string[],
): OverrideResetPlan {
  const owner = state.nodes[instanceId];
  const plan: OverrideResetPlan = { ops: [], swaps: [] };
  if (!owner || owner.type !== "instance") return plan;
  const overrides = owner.overrides ?? {};
  const keys = key ? [key] : Object.keys(overrides);
  const outerFields = new Set(["x", "y", "visible", "locked", "propValues"]);

  for (const k of keys) {
    const patch = overrides[k];
    if (!patch) continue;
    const target = findInstanceNodeByKey(state, owner, k);
    if (!target) continue;
    const nested = target.type === "instance" && target.id !== owner.id && Boolean(target.mainId);
    const outerMaster = nested && target.mainId ? state.nodes[target.mainId] : undefined;
    const ownMaster =
      target.type === "instance"
        ? state.nodes[target.componentId ?? ""]
        : target.mainId
          ? state.nodes[target.mainId]
          : undefined;

    const selected = fields ?? Object.keys(patch);
    let swapTarget: NodeId | null = null;
    if (nested && selected.includes("componentId") && patch.componentId && outerMaster?.componentId) {
      if (target.componentId !== outerMaster.componentId) swapTarget = outerMaster.componentId;
    }
    if (swapTarget) plan.swaps.push({ nodeId: target.id, componentId: swapTarget });

    const update: Partial<DocNode> = {};
    for (const field of selected) {
      if (field === "componentId") continue;
      if (swapTarget && !outerFields.has(field) && field !== "style" && !field.startsWith("style.")) continue;
      const source = nested && outerFields.has(field) ? outerMaster : ownMaster;
      if (!source) continue;

      if (field === "style") {
        const style = { ...target.style };
        for (const sk of Object.keys(patch.style ?? {})) {
          (style as Record<string, unknown>)[sk] = cloneValue((source.style as Record<string, unknown>)[sk]);
        }
        update.style = style;
      } else if (field.startsWith("style.")) {
        const sk = field.slice("style.".length);
        update.style = {
          ...target.style,
          [sk]: cloneValue((source.style as Record<string, unknown>)[sk]),
        };
      } else if (field in patch) {
        (update as Record<string, unknown>)[field] = cloneValue(
          (source as unknown as Record<string, unknown>)[field],
        );
      }
    }
    if (Object.keys(update).length) plan.ops.push({ nodeId: target.id, patch: update });
  }
  return plan;
}
