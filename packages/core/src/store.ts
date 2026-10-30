/**
 * 命令系统：文档变更的唯一入口（ADR-0001）。
 * 确定性 + 可逆 + 可批量；GUI、AI、撤销重做全部走这里。
 */

import type { ComponentPropertyDef, DocNode, DocState, NodeId } from "./model";
import { createNode, walkSubtree, worldRect } from "./model";
import { clampSides } from "./polygon";
import {
  buildSlotDefaultRoots,
  componentOrder,
  computeOuterOverride,
  computeOverridePatch,
  computeSelfOverride,
  findInstanceNodeByKey,
  findOuterOverrideOwner,
  findOverrideOwner,
  materializeInstance,
  nodeKey,
  planInstanceSync,
  planOverrideReset,
  planSwapInstanceClone,
  wouldCreateComponentCycle,
  type SyncOp,
} from "./component";
import { normalizeVector, scaleVector, validateVector, vectorBounds, type VectorPath } from "./vector";
import { collectLayoutContainers, solveContainer } from "./layout-pass";

export type Command =
  | { type: "node.create"; params: { nodes: DocNode[]; parentId: NodeId | null; index?: number } }
  | { type: "node.delete"; params: { nodeId: NodeId } }
  | { type: "node.update"; params: { nodeId: NodeId; patch: Partial<DocNode> } }
  /** 把选区转为主组件：单容器原地转换/提升，多选自动包一层 */
  | { type: "component.create"; params: { nodeIds: NodeId[]; componentId?: NodeId; name?: string } }
  /** 窄重父级：保持调用方给定的局部坐标；用于组件包裹、顶层提升与插槽填充 */
  | { type: "node.reparent"; params: { nodeId: NodeId; parentId: NodeId; index?: number; x?: number; y?: number } }
  /** 插入实例并物化整棵子树；nodeId 由调用方在命令创建前生成 */
  | { type: "instance.create"; params: { componentId: NodeId; parentId: NodeId; nodeId: NodeId; x: number; y: number; name?: string } }
  /** 重置实例覆盖：不传 mainId 表示全部；fields 支持顶层字段与 style.<子字段> */
  | { type: "instance.resetOverride"; params: { instanceId: NodeId; mainId?: NodeId; fields?: string[] } }
  /** 把主组件里的画板/分组转成具名插槽；默认内容是原有子节点 */
  | { type: "slot.create"; params: { nodeId: NodeId; name?: string } }
  /** 用已有节点填充实例里的插槽（默认内容整体被替换）；dx/dy 为拖动产生的世界偏移 */
  | { type: "slot.fill"; params: { slotId: NodeId; nodeIds: NodeId[]; dx?: number; dy?: number } }
  /** 清空实例插槽内容，恢复母版默认内容 */
  | { type: "slot.clear"; params: { slotId: NodeId } }
  /** 从母版图层创建组件属性 */
  | { type: "property.define"; params: { componentId: NodeId; targetMainId: NodeId; id: string; type: "text" | "boolean" | "instance"; name?: string } }
  /** 只改显示名，属性 id 与实例值不变 */
  | { type: "property.rename"; params: { componentId: NodeId; propertyId: string; name: string } }
  | { type: "property.delete"; params: { componentId: NodeId; propertyId: string } }
  /** 设置或清除实例属性值；null 表示回落母版 */
  | { type: "property.set"; params: { instanceId: NodeId; propertyId: string; value: string | boolean | NodeId | null } }
  /** 直接把实例换成另一个组件（保留位置、同名插槽内容） */
  | { type: "instance.swap"; params: { instanceId: NodeId; componentId: NodeId } }
  /** 实例脱离为普通画板；嵌套实例与插槽内容保留 */
  | { type: "component.detach"; params: { instanceId: NodeId } }
  | { type: "token.define"; params: { path: string; tokenType: "color" | "number"; value: string | number } }
  /** 改名是原子操作：token 条目与所有节点引用一起改，只占一步撤销 */
  | { type: "token.rename"; params: { from: string; to: string } };

interface Inverse {
  cmd: Command;
  /** node.delete 的逆需要子树快照 */
  snapshot?: DocNode[];
}

export type ChangeListener = (state: DocState, changedIds: Set<NodeId>) => void;

/** 同步规划器产出的操作 → 普通命令（与 GUI/AI 走同一套 applyOne 与撤销记录）。 */
function syncOpToCommand(op: SyncOp): Command {
  switch (op.kind) {
    case "update":
      return { type: "node.update", params: { nodeId: op.nodeId, patch: op.patch } };
    case "create":
      return { type: "node.create", params: { nodes: op.nodes, parentId: op.parentId } };
    case "delete":
      return { type: "node.delete", params: { nodeId: op.nodeId } };
  }
}

export class DocStore {
  private state: DocState;
  private undoStack: Array<{ label: string; inverses: Inverse[]; revision: number }> = [];
  private redoStack: Array<{ label: string; inverses: Inverse[]; revision: number }> = [];
  /** 内容修订号：每条可撤销记录带一个；撤销/重做回到该记录时修订号也随之回到原值。 */
  private revisionSeq = 0;
  /** 进行中的事务：其内的 apply 不单独入栈，提交时合并成一条。 */
  private transaction: { label: string; inverses: Inverse[] } | null = null;
  /** 落盘时的内容修订号；与当前修订号一致即"干净"。 */
  private savedRevision = 0;
  private listeners = new Set<ChangeListener>();

  constructor(initial: DocState) {
    this.state = initial;
  }

  get doc(): DocState {
    return this.state;
  }

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(changed: Set<NodeId>): void {
    for (const fn of this.listeners) fn(this.state, changed);
  }

  private componentAncestorId(nodeId: NodeId): NodeId | null {
    let cur = this.state.nodes[nodeId]?.parentId;
    while (cur) {
      const node = this.state.nodes[cur];
      if (!node) return null;
      if (node.type === "component") return node.id;
      cur = node.parentId;
    }
    return null;
  }

  private slotsInComponent(componentId: NodeId): DocNode[] {
    const out: DocNode[] = [];
    walkSubtree(this.state, componentId, (n) => {
      if (n.type === "slot") out.push(n);
    });
    return out;
  }

  /** 删除母版结构时保护已填充的插槽内容。 */
  private assertSlotDeletionAllowed(nodeId: NodeId): void {
    const node = this.state.nodes[nodeId];
    if (!node || node.type === "component") return;
    const componentId = this.componentAncestorId(nodeId);
    if (!componentId) return;
    const slots: NodeId[] = [];
    walkSubtree(this.state, nodeId, (n) => {
      if (n.type === "slot") slots.push(n.id);
    });
    if (slots.length === 0) return;
    for (const candidate of Object.values(this.state.nodes)) {
      if (candidate.type !== "slot" || !candidate.slotFilled) continue;
      if (candidate.mainId && slots.includes(candidate.mainId)) {
        const name = this.state.nodes[candidate.mainId]?.name ?? "";
        throw new Error(`插槽「${name}」已被实例填充，请先清空`);
      }
    }
  }

  private expandSlotCreate(cmd: Extract<Command, { type: "slot.create" }>): Command[] {
    const node = this.state.nodes[cmd.params.nodeId];
    if (!node) throw new Error(`节点 ${cmd.params.nodeId} 不存在`);
    if (node.type !== "frame" && node.type !== "group") throw new Error("只能把画板或分组转为插槽");
    if (findOverrideOwner(this.state, node.id)) throw new Error("实例内部不能创建插槽");
    const componentId = this.componentAncestorId(node.id);
    if (!componentId) throw new Error("插槽必须位于主组件内");

    // 插槽不能嵌套插槽
    let cur: DocNode | undefined = node.parentId ? this.state.nodes[node.parentId] : undefined;
    while (cur) {
      if (cur.type === "slot") throw new Error("插槽不能嵌套插槽");
      cur = cur.parentId ? this.state.nodes[cur.parentId] : undefined;
    }
    let nested = false;
    walkSubtree(this.state, node.id, (n) => {
      if (n.id !== node.id && n.type === "slot") nested = true;
    });
    if (nested) throw new Error("插槽不能嵌套插槽");

    const used = new Set(
      this.slotsInComponent(componentId)
        .filter((s) => s.id !== node.id)
        .map((s) => s.name),
    );
    let name = cmd.params.name;
    if (name !== undefined) {
      if (used.has(name)) throw new Error(`插槽名 "${name}" 已存在`);
    } else {
      let i = 1;
      while (used.has(`插槽 ${i}`)) i += 1;
      name = `插槽 ${i}`;
    }
    return [{ type: "node.update", params: { nodeId: node.id, patch: { type: "slot", name } } }];
  }

  private expandSlotFill(cmd: Extract<Command, { type: "slot.fill" }>): Command[] {
    const slot = this.state.nodes[cmd.params.slotId];
    if (!slot || slot.type !== "slot") throw new Error(`插槽 ${cmd.params.slotId} 不存在`);
    if (!findOverrideOwner(this.state, slot.id)) throw new Error("只能填充实例里的插槽");
    if (cmd.params.nodeIds.length === 0) return [];

    const out: Command[] = [];
    // 第一次填充：默认内容整体让位
    if (!slot.slotFilled) {
      for (const childId of [...slot.children]) {
        out.push({ type: "node.delete", params: { nodeId: childId } });
      }
      out.push({ type: "node.update", params: { nodeId: slot.id, patch: { slotFilled: true } } });
    }

    const rect = worldRect(this.state, slot.id);
    if (!rect) throw new Error("插槽没有有效几何");
    const dx = cmd.params.dx ?? 0;
    const dy = cmd.params.dy ?? 0;
    const seen = new Set<NodeId>();
    for (const id of cmd.params.nodeIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = this.state.nodes[id];
      if (!node) throw new Error(`节点 ${id} 不存在`);
      if (id === slot.id) continue;
      // 不能把祖先拖进自己的后代
      let cur: DocNode | undefined = slot;
      while (cur) {
        if (cur.id === id) throw new Error("不能把节点填进自己的后代");
        cur = cur.parentId ? this.state.nodes[cur.parentId] : undefined;
      }
      if (node.parentId === slot.id) continue;
      const nodeRect = worldRect(this.state, id);
      if (!nodeRect) continue;
      out.push({
        type: "node.reparent",
        params: {
          nodeId: id,
          parentId: slot.id,
          x: nodeRect.x + dx - rect.x,
          y: nodeRect.y + dy - rect.y,
        },
      });
    }
    return out;
  }

  private expandSlotClear(cmd: Extract<Command, { type: "slot.clear" }>): Command[] {
    const slot = this.state.nodes[cmd.params.slotId];
    if (!slot || slot.type !== "slot") throw new Error(`插槽 ${cmd.params.slotId} 不存在`);
    if (!findOverrideOwner(this.state, slot.id)) throw new Error("只能清空实例里的插槽");
    const master = slot.mainId ? this.state.nodes[slot.mainId] : null;
    if (!master || master.type !== "slot") throw new Error("找不到插槽的母版");

    const out: Command[] = [];
    for (const childId of [...slot.children]) {
      out.push({ type: "node.delete", params: { nodeId: childId } });
    }
    out.push({ type: "node.update", params: { nodeId: slot.id, patch: { slotFilled: false } } });
    for (const nodes of buildSlotDefaultRoots(this.state, slot.id, master)) {
      out.push({ type: "node.create", params: { nodes, parentId: slot.id } });
    }
    return out;
  }

  /** 在未填充的实例插槽里新建节点/实例：默认内容让位，槽标记为已填充。 */
  private expandSlotPreInsert(parentId: NodeId | null | undefined, cmd: Command): Command[] {
    if (!parentId) return [cmd];
    const slot = this.state.nodes[parentId];
    if (!slot || slot.type !== "slot" || slot.slotFilled) return [cmd];
    if (!findOverrideOwner(this.state, slot.id)) return [cmd];
    const out: Command[] = [];
    for (const childId of [...slot.children]) {
      out.push({ type: "node.delete", params: { nodeId: childId } });
    }
    out.push({ type: "node.update", params: { nodeId: slot.id, patch: { slotFilled: true } } });
    out.push(cmd);
    return out;
  }

  private expandPropertyDefine(cmd: Extract<Command, { type: "property.define" }>): Command[] {
    const component = this.state.nodes[cmd.params.componentId];
    if (!component || component.type !== "component") throw new Error("组件不存在");
    const target = this.state.nodes[cmd.params.targetMainId];
    if (!target) throw new Error("目标图层不存在");
    if (target.mainId && target.type !== "instance") throw new Error("不能给嵌套实例内部的图层创建属性");
    let inside = false;
    walkSubtree(this.state, component.id, (n) => {
      if (n.id === target.id) inside = true;
    });
    if (!inside) throw new Error("属性目标必须位于主组件内");

    const defs = component.propertyDefs ?? [];
    if (defs.some((d) => d.id === cmd.params.id)) throw new Error("属性 id 已存在");
    const key = nodeKey(target);
    if (defs.some((d) => d.targetMainId === key)) throw new Error("该图层已经有组件属性");
    if (cmd.params.type === "text" && target.type !== "text") throw new Error("文本属性只能绑定文本图层");
    if (cmd.params.type === "instance" && target.type !== "instance") {
      throw new Error("实例替换属性只能绑定嵌套实例");
    }

    const used = new Set(defs.map((d) => d.name));
    let name = cmd.params.name;
    if (name === undefined) {
      const base = target.name || "属性";
      name = base;
      let i = 2;
      while (used.has(name)) name = `${base} ${i++}`;
    } else if (used.has(name)) {
      throw new Error(`属性名 "${name}" 已存在`);
    }

    const def: ComponentPropertyDef = {
      id: cmd.params.id,
      name,
      type: cmd.params.type,
      targetMainId: key,
    };
    const out: Command[] = [
      { type: "node.update", params: { nodeId: component.id, patch: { propertyDefs: [...defs, def] } } },
    ];

    // 属性优先：清掉该字段上已有的覆盖，避免删除属性后旧覆盖复活
    const field = def.type === "text" ? "text" : def.type === "boolean" ? "visible" : "componentId";
    for (const inst of Object.values(this.state.nodes)) {
      if (inst.type !== "instance" || inst.componentId !== component.id) continue;
      const current = inst.overrides?.[key];
      if (!current || !(field in current)) continue;
      const nextPatch = { ...current };
      delete (nextPatch as Record<string, unknown>)[field];
      const nextOverrides = { ...(inst.overrides ?? {}) };
      if (Object.keys(nextPatch).length) nextOverrides[key] = nextPatch;
      else delete nextOverrides[key];
      out.push({
        type: "node.update",
        params: {
          nodeId: inst.id,
          patch: { overrides: Object.keys(nextOverrides).length ? nextOverrides : undefined },
        },
      });
    }
    return out;
  }

  private expandPropertyRename(cmd: Extract<Command, { type: "property.rename" }>): Command[] {
    const component = this.state.nodes[cmd.params.componentId];
    if (!component || component.type !== "component") throw new Error("组件不存在");
    const defs = component.propertyDefs ?? [];
    const def = defs.find((d) => d.id === cmd.params.propertyId);
    if (!def) throw new Error("属性不存在");
    const name = cmd.params.name.trim();
    if (!name) throw new Error("属性名不能为空");
    if (defs.some((d) => d.id !== def.id && d.name === name)) throw new Error(`属性名 "${name}" 已存在`);
    return [
      {
        type: "node.update",
        params: {
          nodeId: component.id,
          patch: { propertyDefs: defs.map((d) => (d.id === def.id ? { ...d, name } : d)) },
        },
      },
    ];
  }

  private expandPropertyDelete(cmd: Extract<Command, { type: "property.delete" }>): Command[] {
    const component = this.state.nodes[cmd.params.componentId];
    if (!component || component.type !== "component") throw new Error("组件不存在");
    const defs = component.propertyDefs ?? [];
    const def = defs.find((d) => d.id === cmd.params.propertyId);
    if (!def) throw new Error("属性不存在");
    const nextDefs = defs.filter((d) => d.id !== def.id);
    const out: Command[] = [
      {
        type: "node.update",
        params: { nodeId: component.id, patch: { propertyDefs: nextDefs.length ? nextDefs : undefined } },
      },
    ];
    for (const inst of Object.values(this.state.nodes)) {
      if (inst.type !== "instance" || inst.componentId !== component.id) continue;
      if (!inst.propValues || !(def.id in inst.propValues)) continue;
      const nextValues = { ...inst.propValues };
      delete nextValues[def.id];
      out.push({
        type: "node.update",
        params: {
          nodeId: inst.id,
          patch: { propValues: Object.keys(nextValues).length ? nextValues : undefined },
        },
      });
    }
    return out;
  }

  private expandPropertySet(cmd: Extract<Command, { type: "property.set" }>): Command[] {
    const instance = this.state.nodes[cmd.params.instanceId];
    if (!instance || instance.type !== "instance" || !instance.componentId) throw new Error("实例不存在");
    const component = this.state.nodes[instance.componentId];
    const def = component?.type === "component" ? component.propertyDefs?.find((d) => d.id === cmd.params.propertyId) : undefined;
    if (!def) throw new Error("属性不存在");

    const value = cmd.params.value;
    if (value !== null) {
      if (def.type === "text" && typeof value !== "string") throw new Error("文本属性需要字符串");
      if (def.type === "boolean" && typeof value !== "boolean") throw new Error("布尔属性需要布尔值");
      if (def.type === "instance") {
        const next = this.state.nodes[String(value)];
        if (!next || next.type !== "component") throw new Error("实例替换需要有效组件");
      }
    }

    const out: Command[] = [];
    const nextValues = { ...(instance.propValues ?? {}) };
    if (value === null) delete nextValues[def.id];
    else nextValues[def.id] = value;
    out.push({
      type: "node.update",
      params: {
        nodeId: instance.id,
        patch: { propValues: Object.keys(nextValues).length ? nextValues : undefined },
      },
    });

    const target = findInstanceNodeByKey(this.state, instance, def.targetMainId);
    if (!target) return out;
    const master = this.state.nodes[def.targetMainId];
    if (def.type === "text") {
      out.push({
        type: "node.update",
        params: { nodeId: target.id, patch: { text: value === null ? master?.text : String(value) } },
      });
    } else if (def.type === "boolean") {
      out.push({
        type: "node.update",
        params: {
          nodeId: target.id,
          patch: { visible: value === null ? (master ? master.visible : true) : Boolean(value) },
        },
      });
    } else if (target.type === "instance") {
      const nextComponentId = value === null ? master?.componentId : String(value);
      if (!nextComponentId) return out;
      if (wouldCreateComponentCycle(this.state, nextComponentId, target.parentId ?? "")) {
        throw new Error("实例替换会形成组件循环");
      }
      if (target.componentId !== nextComponentId) {
        for (const op of planSwapInstanceClone(this.state, target, nextComponentId)) {
          out.push(syncOpToCommand(op));
        }
      }
    }
    return out;
  }

  private expandInstanceSwap(cmd: Extract<Command, { type: "instance.swap" }>): Command[] {
    const instance = this.state.nodes[cmd.params.instanceId];
    if (!instance || instance.type !== "instance") throw new Error("实例不存在");
    const component = this.state.nodes[cmd.params.componentId];
    if (!component || component.type !== "component") throw new Error("目标组件不存在");
    const outer = findOuterOverrideOwner(this.state, instance.id);
    if (outer) {
      const defs = this.state.nodes[outer.owner.componentId ?? ""]?.propertyDefs ?? [];
      if (defs.some((d) => d.targetMainId === outer.key && d.type === "instance")) {
        throw new Error("该实例的组件由组件属性控制，请修改属性值");
      }
    }
    if (instance.componentId === component.id) return [];
    if (wouldCreateComponentCycle(this.state, component.id, instance.parentId ?? "")) {
      throw new Error("实例替换会形成组件循环");
    }
    return planSwapInstanceClone(this.state, instance, component.id).map(syncOpToCommand);
  }

  private isDescendantOf(nodeId: NodeId, ancestorId: NodeId): boolean {
    let cur = this.state.nodes[nodeId]?.parentId;
    while (cur) {
      if (cur === ancestorId) return true;
      cur = this.state.nodes[cur]?.parentId ?? null;
    }
    return false;
  }

  /** 脱离：实例根转画板；插槽转画板（空槽删除）；嵌套实例保留。 */
  private expandDetach(instanceId: NodeId): Command[] {
    const instance = this.state.nodes[instanceId];
    if (!instance || instance.type !== "instance") throw new Error("实例不存在");
    const out: Command[] = [
      {
        type: "node.update",
        params: {
          nodeId: instance.id,
          patch: {
            type: "frame",
            componentId: undefined,
            mainId: undefined,
            overrides: undefined,
            propValues: undefined,
            slotFilled: undefined,
          },
        },
      },
    ];
    const visit = (parentId: NodeId): void => {
      const parent = this.state.nodes[parentId];
      if (!parent) return;
      for (const childId of [...parent.children]) {
        const child = this.state.nodes[childId];
        if (!child) continue;
        if (child.type === "instance") {
          // 嵌套实例保持为实例，但不再属于外层实例树
          out.push({ type: "node.update", params: { nodeId: child.id, patch: { mainId: child.componentId, slotFilled: undefined } } });
          continue;
        }
        if (child.type === "slot") {
          if (child.children.length === 0) {
            out.push({ type: "node.delete", params: { nodeId: child.id } });
            continue;
          }
          out.push({
            type: "node.update",
            params: { nodeId: child.id, patch: { type: "frame", slotFilled: undefined, mainId: undefined } },
          });
        } else {
          out.push({ type: "node.update", params: { nodeId: child.id, patch: { mainId: undefined, slotFilled: undefined } } });
        }
        visit(child.id);
      }
    };
    visit(instance.id);
    return out;
  }

  /** 删除组件/页面时，先把引用它们的实例脱离，再删除。 */
  private expandDelete(cmd: Extract<Command, { type: "node.delete" }>): Command[] {
    const node = this.state.nodes[cmd.params.nodeId];
    if (!node) return [cmd];
    const components = new Set<NodeId>();
    if (node.type === "component") components.add(node.id);
    walkSubtree(this.state, node.id, (n) => {
      if (n.id !== node.id && n.type === "component") components.add(n.id);
    });
    if (components.size === 0) return [cmd];

    const out: Command[] = [];
    const detached = new Set<NodeId>();
    for (const componentId of components) {
      for (const instance of Object.values(this.state.nodes)) {
        if (instance.type !== "instance" || instance.componentId !== componentId) continue;
        if (detached.has(instance.id)) continue;
        if (instance.id === node.id || this.isDescendantOf(instance.id, node.id)) continue;
        detached.add(instance.id);
        out.push(...this.expandDetach(instance.id));
      }
    }
    out.push(cmd);
    return out;
  }

  /**
   * 高阶命令展开：component.create 变成基础命令（create/update/reparent），
   * 这样撤销、原子校验与同步都复用现有机制，不需要专门的逆命令。
   */
  private expand(list: Command[]): Command[] {
    const usedNames = new Set(
      Object.values(this.state.nodes)
        .filter((n) => n.type === "component")
        .map((n) => n.name),
    );
    const nameFor = (explicit?: string): string => {
      if (explicit) {
        usedNames.add(explicit);
        return explicit;
      }
      let i = 1;
      while (usedNames.has(`组件 ${i}`)) i += 1;
      const name = `组件 ${i}`;
      usedNames.add(name);
      return name;
    };
    const out: Command[] = [];
    for (const cmd of list) {
      if (cmd.type === "component.create") out.push(...this.expandComponentCreate(cmd, nameFor));
      else if (cmd.type === "instance.resetOverride") {
        const plan = planOverrideReset(
          this.state,
          cmd.params.instanceId,
          cmd.params.mainId,
          cmd.params.fields,
        );
        for (const swap of plan.swaps) {
          const target = this.state.nodes[swap.nodeId];
          if (target?.type === "instance" && target.componentId !== swap.componentId) {
            for (const op of planSwapInstanceClone(this.state, target, swap.componentId)) {
              out.push(syncOpToCommand(op));
            }
          }
        }
        for (const op of plan.ops) {
          out.push({ type: "node.update", params: { nodeId: op.nodeId, patch: op.patch } });
        }
      } else if (cmd.type === "slot.create") out.push(...this.expandSlotCreate(cmd));
      else if (cmd.type === "slot.fill") out.push(...this.expandSlotFill(cmd));
      else if (cmd.type === "slot.clear") out.push(...this.expandSlotClear(cmd));
      else if (cmd.type === "property.define") out.push(...this.expandPropertyDefine(cmd));
      else if (cmd.type === "property.rename") out.push(...this.expandPropertyRename(cmd));
      else if (cmd.type === "property.delete") out.push(...this.expandPropertyDelete(cmd));
      else if (cmd.type === "property.set") out.push(...this.expandPropertySet(cmd));
      else if (cmd.type === "instance.swap") out.push(...this.expandInstanceSwap(cmd));
      else if (cmd.type === "component.detach") out.push(...this.expandDetach(cmd.params.instanceId));
      else if (cmd.type === "node.delete") out.push(...this.expandDelete(cmd));
      else if (cmd.type === "node.create") out.push(...this.expandSlotPreInsert(cmd.params.parentId, cmd));
      else if (cmd.type === "instance.create") out.push(...this.expandSlotPreInsert(cmd.params.parentId, cmd));
      else out.push(cmd);
    }
    return out;
  }

  private pageOf(nodeId: NodeId): DocNode | null {
    let cur: DocNode | undefined = this.state.nodes[nodeId];
    while (cur && cur.type !== "page") {
      cur = cur.parentId ? this.state.nodes[cur.parentId] : undefined;
    }
    return cur ?? null;
  }

  private hasComponentAncestor(nodeId: NodeId): boolean {
    let cur = this.state.nodes[nodeId]?.parentId;
    while (cur) {
      const node = this.state.nodes[cur];
      if (!node) return false;
      if (node.type === "component") return true;
      cur = node.parentId;
    }
    return false;
  }

  private hasInstanceAncestor(nodeId: NodeId): boolean {
    let cur = this.state.nodes[nodeId]?.parentId;
    while (cur) {
      const node = this.state.nodes[cur];
      if (!node) return false;
      if (node.type === "instance") return true;
      cur = node.parentId;
    }
    return false;
  }

  private expandComponentCreate(
    cmd: Extract<Command, { type: "component.create" }>,
    nameFor: (explicit?: string) => string,
  ): Command[] {
    const ids = [...new Set(cmd.params.nodeIds)];
    if (ids.length === 0) throw new Error("请选择要转成组件的节点");
    for (const id of ids) {
      const node = this.state.nodes[id];
      if (!node) throw new Error(`节点 ${id} 不存在`);
      if (node.type === "page") throw new Error("页面不能转成组件");
      if (node.type === "component") throw new Error("组件不能嵌套组件");
      if (this.hasComponentAncestor(id)) throw new Error("组件不能嵌套组件");
      if (this.hasInstanceAncestor(id)) throw new Error("实例内部不能创建组件");
    }

    // 选区里同时包含祖先与后代时，只处理最外层节点
    const set = new Set(ids);
    const top = ids.filter((id) => {
      let cur = this.state.nodes[id].parentId;
      while (cur) {
        if (set.has(cur)) return false;
        cur = this.state.nodes[cur]?.parentId ?? null;
      }
      return true;
    });

    const page = this.pageOf(top[0]);
    if (!page) throw new Error("节点必须位于页面内");
    if (top.some((id) => this.pageOf(id)?.id !== page.id)) throw new Error("选区必须位于同一页面");
    const name = nameFor(cmd.params.name);

    // 单个画板/分组：原地转换；嵌套时提升到页面顶层，保持世界坐标
    if (top.length === 1) {
      const node = this.state.nodes[top[0]];
      if (node.type === "frame" || node.type === "group") {
        const out: Command[] = [];
        if (node.parentId !== page.id) {
          const r = worldRect(this.state, node.id)!;
          out.push({
            type: "node.reparent",
            params: { nodeId: node.id, parentId: page.id, x: r.x - page.x, y: r.y - page.y },
          });
        }
        out.push({ type: "node.update", params: { nodeId: node.id, patch: { type: "component", name } } });
        return out;
      }
    }

    // 其余情况：按选区并集包一层主组件，再把节点重定父级进去
    const componentId = cmd.params.componentId;
    if (!componentId) throw new Error("多选创建组件需要提供 componentId");
    if (this.state.nodes[componentId]) throw new Error(`节点 ${componentId} 已存在`);
    const rects = top.map((id) => worldRect(this.state, id)!);
    const left = Math.min(...rects.map((r) => r.x));
    const topY = Math.min(...rects.map((r) => r.y));
    const right = Math.max(...rects.map((r) => r.x + r.width));
    const bottom = Math.max(...rects.map((r) => r.y + r.height));
    const component = createNode("component", {
      id: componentId,
      name,
      parentId: page.id,
      x: left - page.x,
      y: topY - page.y,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - topY),
      style: {},
    });
    const out: Command[] = [{ type: "node.create", params: { nodes: [component], parentId: page.id } }];
    for (const id of top) {
      const r = worldRect(this.state, id)!;
      out.push({
        type: "node.reparent",
        params: { nodeId: id, parentId: componentId, x: r.x - left, y: r.y - topY },
      });
    }
    return out;
  }

  /** 命令执行前：把受影响的组件收集起来（删除命令依赖删除前的树）。 */
  private collectAffected(cmd: Command, out: Set<NodeId>): void {
    switch (cmd.type) {
      case "node.create":
        this.collectComponents(cmd.params.parentId, out);
        break;
      case "node.update":
      case "node.delete":
        this.collectComponents(cmd.params.nodeId, out);
        break;
      case "node.reparent":
        this.collectComponents(cmd.params.nodeId, out);
        this.collectComponents(cmd.params.parentId, out);
        break;
      case "instance.create":
        this.collectComponents(cmd.params.parentId, out);
        break;
      default:
        break;
    }
  }

  private collectComponents(nodeId: NodeId | null | undefined, out: Set<NodeId>): void {
    let cur = nodeId ? this.state.nodes[nodeId] : undefined;
    while (cur) {
      if (cur.type === "component") out.add(cur.id);
      cur = cur.parentId ? this.state.nodes[cur.parentId] : undefined;
    }
  }

  /** 删除母版节点时，清掉指向它的组件属性与实例值。 */
  private collectPropertyCleanup(list: Command[]): Array<{ componentId: NodeId; keys: Set<NodeId> }> {
    const out: Array<{ componentId: NodeId; keys: Set<NodeId> }> = [];
    for (const cmd of list) {
      if (cmd.type !== "node.delete") continue;
      const node = this.state.nodes[cmd.params.nodeId];
      if (!node || node.type === "component") continue;
      const componentId = this.componentAncestorId(cmd.params.nodeId);
      if (!componentId) continue;
      const keys = new Set<NodeId>();
      walkSubtree(this.state, cmd.params.nodeId, (n) => keys.add(nodeKey(n)));
      if (keys.size) out.push({ componentId, keys });
    }
    return out;
  }

  private cleanupDeletedProperties(
    plans: Array<{ componentId: NodeId; keys: Set<NodeId> }>,
    affected: Set<NodeId>,
    changed: Set<NodeId>,
    inverses: Inverse[],
  ): void {
    for (const plan of plans) {
      const component = this.state.nodes[plan.componentId];
      if (!component || component.type !== "component") continue;
      const defs = component.propertyDefs ?? [];
      const removed = defs.filter((d) => plan.keys.has(d.targetMainId));
      if (removed.length === 0) continue;
      const nextDefs = defs.filter((d) => !plan.keys.has(d.targetMainId));
      inverses.unshift(
        this.applyOne(
          {
            type: "node.update",
            params: { nodeId: component.id, patch: { propertyDefs: nextDefs.length ? nextDefs : undefined } },
          },
          changed,
        ),
      );
      this.collectComponents(component.id, affected);
      const ids = new Set(removed.map((d) => d.id));
      for (const inst of Object.values(this.state.nodes)) {
        if (inst.type !== "instance" || inst.componentId !== component.id || !inst.propValues) continue;
        const next = { ...inst.propValues };
        let dirty = false;
        for (const id of ids) {
          if (id in next) {
            delete next[id];
            dirty = true;
          }
        }
        if (!dirty) continue;
        inverses.unshift(
          this.applyOne(
            {
              type: "node.update",
              params: {
                nodeId: inst.id,
                patch: { propValues: Object.keys(next).length ? next : undefined },
              },
            },
            changed,
          ),
        );
      }
    }
  }

  /**
   * 自动覆盖记录：编辑实例内部字段后，按字段比对母版并写入/清除覆盖。
   * 覆盖表本身的变化是普通 node.update，随同一个撤销条目回滚。
   */
  private recordOverrides(
    list: Command[],
    affected: Set<NodeId>,
    changed: Set<NodeId>,
    inverses: Inverse[],
  ): void {
    for (const cmd of list) {
      if (cmd.type !== "node.update") continue;
      const keys = Object.keys(cmd.params.patch);
      if (keys.length > 0 && keys.every((k) => k === "overrides")) continue;
      const node = this.state.nodes[cmd.params.nodeId];
      if (!node) continue;

      if (node.type === "instance") {
        if (node.componentId) {
          this.writeOverride(node, node.componentId, computeSelfOverride(this.state, node.id), affected, changed, inverses);
        }
        const outer = findOuterOverrideOwner(this.state, node.id);
        if (outer) {
          this.writeOverride(outer.owner, outer.key, computeOuterOverride(this.state, node.id), affected, changed, inverses);
        }
        continue;
      }

      const info = findOverrideOwner(this.state, node.id);
      if (!info) continue;
      this.writeOverride(info.owner, info.key, computeOverridePatch(this.state, node.id), affected, changed, inverses);
    }
  }

  private writeOverride(
    owner: DocNode,
    key: NodeId,
    patch: ReturnType<typeof computeOverridePatch>,
    affected: Set<NodeId>,
    changed: Set<NodeId>,
    inverses: Inverse[],
  ): void {
    if (!key) return;
    const current = owner.overrides ?? {};
    const next = { ...current };
    if (patch) next[key] = patch;
    else delete next[key];
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    inverses.unshift(
      this.applyOne(
        {
          type: "node.update",
          params: {
            nodeId: owner.id,
            patch: { overrides: Object.keys(next).length ? next : undefined },
          },
        },
        changed,
      ),
    );
    this.collectComponents(owner.id, affected);
  }

  /**
   * 母版改动后的级联同步：按组件依赖顺序处理，被同步的实例如在另一个母版里，
   * 会把那个母版也加入队列。所有逆命令进同一个撤销条目。
   */
  private syncComponents(affected: Set<NodeId>, changed: Set<NodeId>, inverses: Inverse[]): void {
    if (affected.size === 0) return;
    for (const componentId of componentOrder(this.state)) {
      if (!affected.delete(componentId)) continue;
      this.syncComponent(componentId, affected, changed, inverses);
    }
  }

  private syncComponent(
    componentId: NodeId,
    affected: Set<NodeId>,
    changed: Set<NodeId>,
    inverses: Inverse[],
  ): void {
    const instances = Object.values(this.state.nodes)
      .filter((n) => n.type === "instance" && n.componentId === componentId)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const instance of instances) {
      // 更早的同步可能已经删掉/换掉这个实例
      if (this.state.nodes[instance.id]?.type !== "instance") continue;
      for (const op of planInstanceSync(this.state, instance.id)) {
        if (op.kind === "delete") this.collectComponents(this.state.nodes[op.nodeId]?.parentId, affected);
        if (op.kind === "create") this.collectComponents(op.parentId, affected);
        inverses.unshift(this.applyOne(syncOpToCommand(op), changed));
        if (op.kind === "update") this.collectComponents(op.nodeId, affected);
      }
    }
  }

  /** 节点自身或任一祖先是否锁定。 */
  private isLockedChain(nodeId: NodeId): boolean {
    let cur: DocNode | undefined = this.state.nodes[nodeId];
    while (cur) {
      if (cur.locked) return true;
      cur = cur.parentId ? this.state.nodes[cur.parentId] : undefined;
    }
    return false;
  }

  /**
   * 锁定校验只作用于「用户命令入口」：系统同步、布局写回与撤销回放走 applyOne，不经过这里。
   * 只允许对锁定节点修改 locked 本身。
   */
  private validateLocks(list: Command[]): void {
    for (const cmd of list) {
      switch (cmd.type) {
        case "node.update": {
          const node = this.state.nodes[cmd.params.nodeId];
          if (!node) break;
          const keys = Object.keys(cmd.params.patch);
          if (keys.length === 0) break;
          if (keys.every((k) => k === "locked")) break;
          if (this.isLockedChain(node.id)) throw new Error(`节点「${node.name}」已锁定`);
          break;
        }
        case "node.delete": {
          const node = this.state.nodes[cmd.params.nodeId];
          if (node && this.isLockedChain(node.id)) throw new Error(`节点「${node.name}」已锁定`);
          break;
        }
        case "node.create": {
          const parentId = cmd.params.parentId;
          if (parentId && this.isLockedChain(parentId)) throw new Error("不能修改已锁定节点的内容");
          break;
        }
        case "node.reparent": {
          const { nodeId, parentId } = cmd.params;
          if (this.isLockedChain(nodeId)) throw new Error("不能移动已锁定节点");
          if (this.isLockedChain(parentId)) throw new Error("不能修改已锁定节点的内容");
          break;
        }
        case "instance.create": {
          if (this.isLockedChain(cmd.params.parentId)) throw new Error("不能修改已锁定节点的内容");
          break;
        }
        default:
          break;
      }
    }
  }

  /** 事务末尾的布局求解：结果写回与用户命令共用同一个撤销条目。 */
  private runLayoutPass(changed: Set<NodeId>, inverses: Inverse[]): void {
    const containers = collectLayoutContainers(this.state, changed);
    for (const id of containers) {
      const container = this.state.nodes[id];
      if (!container?.layout) continue;
      const solved = solveContainer(this.state, container);
      if (!solved) continue;
      for (const item of solved.items) {
        const child = this.state.nodes[item.id];
        if (!child) continue;
        const patch: Partial<DocNode> = {};
        for (const key of ["x", "y", "width", "height"] as const) {
          if (Math.abs((child[key] as number) - item[key]) > 0.001) patch[key] = item[key];
        }
        if (Object.keys(patch).length > 0) {
          inverses.unshift(this.applyOne({ type: "node.update", params: { nodeId: item.id, patch } }, changed));
        }
      }
      const box: Partial<DocNode> = {};
      if (Math.abs(container.width - solved.width) > 0.001) box.width = solved.width;
      if (Math.abs(container.height - solved.height) > 0.001) box.height = solved.height;
      if (Object.keys(box).length > 0) {
        inverses.unshift(this.applyOne({ type: "node.update", params: { nodeId: container.id, patch: box } }, changed));
      }
    }
  }

  /**
   * 批命令前置校验：applyOne 内会抛错的规则全部前移。
   * 保证「要么全成、要么全不成」——中途抛错不会留下已生效但没进撤销栈的改动。
   */
  private validateOne(cmd: Command, pending: Set<NodeId> = new Set()): void {
    switch (cmd.type) {
      case "node.create":
        for (const n of cmd.params.nodes) if (n.vector) validateVector(n.vector);
        break;
      case "node.update":
        if (cmd.params.patch.vector) validateVector(cmd.params.patch.vector as VectorPath);
        {
          const node = this.state.nodes[cmd.params.nodeId];
          const patch = cmd.params.patch;
          if (node?.type === "slot" && patch.name !== undefined && patch.type === undefined) {
            const componentId = this.componentAncestorId(node.id);
            if (componentId) {
              const used = this.slotsInComponent(componentId)
                .filter((s) => s.id !== node.id)
                .map((s) => s.name);
              if (used.includes(String(patch.name))) {
                throw new Error(`插槽名 "${String(patch.name)}" 已存在`);
              }
            }
          }
        }
        break;
      case "node.delete":
        this.assertSlotDeletionAllowed(cmd.params.nodeId);
        break;
      case "component.create":
        // 已在 apply 前展开；走到这里说明调用方绕过了展开
        throw new Error("component.create 必须先展开");
      case "node.reparent": {
        const { nodeId, parentId } = cmd.params;
        const node = this.state.nodes[nodeId];
        if (!node) {
          if (!pending.has(nodeId)) throw new Error(`节点 ${nodeId} 不存在`);
          break; // 同一批里刚创建，交给执行期
        }
        if (node.type === "page") throw new Error("页面不能重定父级");
        if (!node.parentId || !this.state.nodes[node.parentId]) throw new Error("根节点不能重定父级");
        const parent = this.state.nodes[parentId];
        if (!parent) {
          if (!pending.has(parentId)) throw new Error(`父节点 ${parentId} 不存在`);
          break; // 同一批里刚创建，交给执行期
        }
        let cur: DocNode | undefined = parent;
        while (cur) {
          if (cur.id === nodeId) throw new Error("不能把节点移到自己的后代里");
          cur = cur.parentId ? this.state.nodes[cur.parentId] : undefined;
        }
        if (node.type === "component" && parent.type !== "page") {
          throw new Error("主组件必须位于页面顶层");
        }
        break;
      }
      case "instance.create": {
        const { componentId, parentId, nodeId } = cmd.params;
        const master = this.state.nodes[componentId];
        if (!master || master.type !== "component") throw new Error(`组件 ${componentId} 不存在`);
        if (!this.state.nodes[parentId]) throw new Error(`父节点 ${parentId} 不存在`);
        if (wouldCreateComponentCycle(this.state, componentId, parentId)) {
          throw new Error("组件不能直接或间接包含自身");
        }
        // 派生 id 必须可用：重复物化不能覆盖已有节点
        for (const n of materializeInstance(this.state, componentId, nodeId, parentId, 0, 0)) {
          if (this.state.nodes[n.id]) throw new Error(`实例节点 id ${n.id} 已存在`);
        }
        break;
      }
      default:
        break;
    }
  }

  /** 应用一条或一批命令（原子）；自动记录逆命令供撤销。 */
  apply(cmds: Command | Command[], label = "edit"): void {
    const list = this.expand(Array.isArray(cmds) ? cmds : [cmds]);
    this.validateLocks(list);
    const affected = new Set<NodeId>();
    for (const cmd of list) this.collectAffected(cmd, affected);
    const pending = new Set<NodeId>();
    for (const cmd of list) {
      this.validateOne(cmd, pending);
      if (cmd.type === "node.create") for (const n of cmd.params.nodes) pending.add(n.id);
    }
    const inverses: Inverse[] = [];
    const changed = new Set<NodeId>();
    const cleanup = this.collectPropertyCleanup(list);
    for (const cmd of list) {
      inverses.unshift(this.applyOne(cmd, changed));
    }
    this.cleanupDeletedProperties(cleanup, affected, changed, inverses);
    this.recordOverrides(list, affected, changed, inverses);
    this.syncComponents(affected, changed, inverses);
    this.runLayoutPass(changed, inverses);
    if (inverses.length > 0) {
      if (this.transaction) {
        // 逆操作按"后发生的在前"合并，撤销时才能正确倒放
        this.transaction.inverses = [...inverses, ...this.transaction.inverses];
      } else {
        this.undoStack.push({ label, inverses, revision: ++this.revisionSeq });
        this.redoStack = [];
      }
      this.state.version += 1;
      this.emit(changed);
    }
  }

  /**
   * 事务：把一段同步/异步执行中的多条命令合并成**一条**撤销记录。
   *
   * - 内层事务不新建记录，并入最外层（内层抛错会继续向上抛，回滚由最外层负责）；
   * - 抛错时把已执行的命令按逆序回滚，文档回到进入事务前的状态，撤销栈不留记录；
   * - 命令的确定性约束不变：事务内仍然禁止 `Date.now`／随机／IO。
   *
   * **只允许一个事务在飞**：合并语义是针对嵌套设计的，区分不了"嵌套"与"并发"。
   * 并发进入的事务会被并进第一个事务（撤销/回滚会连带影响另一个调用），
   * 所以宿主（MCP 执行器）必须保证调用串行——见 `apps/desktop/src/main/mcp/queue.ts`。
   */
  async transact<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    if (this.transaction) return fn();

    const mine: { label: string; inverses: Inverse[] } = { label, inverses: [] };
    this.transaction = mine;
    try {
      const result = await fn();
      // 可能已被 `abortTransact()` 中止：那样就不再落撤销记录
      if (this.transaction === mine) {
        this.transaction = null;
        if (mine.inverses.length > 0) {
          this.undoStack.push({ label, inverses: mine.inverses, revision: ++this.revisionSeq });
          this.redoStack = [];
          // 提交发生在最后一次 emit 之后：再通知一次，让"脏标记 / 窗口标题"这类订阅者看到新状态。
          // 少了这一下，MCP 改完文档主进程仍以为它是干净的（⌘Q 会静默丢稿）。
          this.emit(new Set<NodeId>());
        }
      }
      return result;
    } catch (error) {
      if (this.transaction === mine) {
        this.transaction = null;
        this.rollback(mine.inverses);
      }
      throw error;
    }
  }

  /**
   * 中止进行中的事务：把已执行的命令倒放回事务开始前，且**不留撤销记录**。
   * 用于"拖到一半按 Esc"——手势取消不该在撤销栈里留下一条净效果为空的记录。
   */
  abortTransact(): void {
    const tx = this.transaction;
    if (!tx) return;
    this.transaction = null;
    this.rollback(tx.inverses);
  }

  /** 事务失败时倒放已执行的命令；不产生撤销记录。 */
  private rollback(inverses: Inverse[]): void {
    if (inverses.length === 0) return;
    const changed = new Set<NodeId>();
    for (const inv of inverses) this.applyOne(inv.cmd, changed, inv.snapshot);
    this.state.version += 1;
    this.emit(changed);
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const changed = new Set<NodeId>();
    const forward: Inverse[] = [];
    for (const inv of entry.inverses) {
      forward.unshift(this.applyOne(inv.cmd, changed, inv.snapshot));
    }
    this.redoStack.push({ label: entry.label, inverses: forward, revision: entry.revision });
    this.state.version += 1;
    this.emit(changed);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const changed = new Set<NodeId>();
    const back: Inverse[] = [];
    for (const inv of entry.inverses) {
      back.unshift(this.applyOne(inv.cmd, changed, inv.snapshot));
    }
    this.undoStack.push({ label: entry.label, inverses: back, revision: entry.revision });
    this.state.version += 1;
    this.emit(changed);
    return true;
  }

  /**
   * 当前文档自上次落盘以来是否有改动。
   * 以"保存点"为准：分支号与撤销/重做栈深度都回到保存时的值才算干净，
   * 因此"改一下 → 撤销 → 重做"会正确回到干净状态。
   */
  get isDirty(): boolean {
    return this.currentRevision() !== this.savedRevision;
  }

  /** 当前内容对应的修订号（撤销到某条记录时回到它的修订号，因此"撤销→重做"会重新变干净）。 */
  private currentRevision(): number {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1].revision : 0;
  }

  /** 标记"当前状态已落盘"；打开文件后也用它把基线对齐。 */
  markSaved(): void {
    this.savedRevision = this.currentRevision();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** 下一条将被撤销的记录名（调试与"agent 改了什么"的提示用）。 */
  get undoLabel(): string | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1].label : null;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private applyOne(cmd: Command, changed: Set<NodeId>, snapshot?: DocNode[]): Inverse {
    switch (cmd.type) {
      case "node.create": {
        const { nodes, parentId, index } = cmd.params;
        const storedNodes: DocNode[] = [];
        for (const n of nodes) {
          // 归一化写在副本上：命令参数属于调用方，apply 不应改写它
          const stored: DocNode = { ...n };
          if (stored.vector) {
            // 路径的锚点允许以父容器坐标传入：平移归一化后由包围盒推导节点框
            validateVector(stored.vector);
            const norm = normalizeVector(stored.vector.anchors, stored.vector.closed);
            stored.vector = norm.vector;
            stored.x += norm.bounds.x;
            stored.y += norm.bounds.y;
            stored.width = Math.max(1, norm.bounds.width);
            stored.height = Math.max(1, norm.bounds.height);
          }
          if (stored.type === "polygon") {
            // 边数是多边形唯一的形状参数：任何入口（GUI / AI）都给同一套夹紧
            stored.sides = clampSides(stored.sides);
            stored.width = Math.max(1, stored.width);
            stored.height = Math.max(1, stored.height);
          }
          storedNodes.push(stored);
          this.state.nodes[stored.id] = stored;
        }
        const parent = parentId ? this.state.nodes[parentId] : null;
        const rootId = storedNodes[0].id;
        if (parent) {
          const at = index ?? parent.children.length;
          parent.children.splice(at, 0, rootId);
          storedNodes[0].parentId = parent.id;
          changed.add(parent.id);
        } else {
          this.state.rootIds.push(rootId);
        }
        for (const n of storedNodes) changed.add(n.id);
        return { cmd: { type: "node.delete", params: { nodeId: rootId } } };
      }
      case "node.delete": {
        const { nodeId } = cmd.params;
        const removed: DocNode[] = [];
        walkSubtree(this.state, nodeId, (n) => removed.push({ ...n, children: [...n.children] }));
        const node = this.state.nodes[nodeId];
        if (!node) return { cmd: { type: "node.update", params: { nodeId, patch: {} } } };
        const parentId = node.parentId;
        const parent = parentId ? this.state.nodes[parentId] : null;
        const index = parent ? parent.children.indexOf(nodeId) : this.state.rootIds.indexOf(nodeId);
        if (parent) parent.children.splice(parent.children.indexOf(nodeId), 1);
        else this.state.rootIds.splice(this.state.rootIds.indexOf(nodeId), 1);
        if (parent) changed.add(parent.id);
        for (const n of removed) {
          delete this.state.nodes[n.id];
          changed.add(n.id);
        }
        // 逆命令：重建子树（removed 为前序快照，parentId 指向原父）
        const rebuild = removed.map((n, i) => (i === 0 ? { ...n, parentId } : n));
        return { cmd: { type: "node.create", params: { nodes: rebuild, parentId, index } } };
      }
      case "node.update": {
        const { nodeId } = cmd.params;
        const node = this.state.nodes[nodeId];
        if (!node) return { cmd: { type: "node.update", params: { nodeId, patch: {} } } };
        // 路径的两个隐式规则：给 vector 时包围盒即节点框；只改宽高时按比例缩放锚点
        const next: Partial<DocNode> = { ...cmd.params.patch };
        if (next.vector) {
          validateVector(next.vector as VectorPath);
          const norm = normalizeVector(next.vector.anchors, next.vector.closed);
          next.vector = norm.vector;
          next.x = (next.x ?? node.x) + norm.bounds.x;
          next.y = (next.y ?? node.y) + norm.bounds.y;
          next.width = Math.max(1, norm.bounds.width);
          next.height = Math.max(1, norm.bounds.height);
        } else if (node.vector && (next.width !== undefined || next.height !== undefined)) {
          const sx = next.width !== undefined ? (next.width as number) / Math.max(1, node.width) : 1;
          const sy = next.height !== undefined ? (next.height as number) / Math.max(1, node.height) : 1;
          const scaled = scaleVector(node.vector, sx, sy);
          const bounds = vectorBounds(scaled);
          next.vector = scaled;
          // 扁平路径在垂直于自身的方向上没有跨度：以包围盒为准，保证节点框与几何一致
          next.width = Math.max(1, bounds.width);
          next.height = Math.max(1, bounds.height);
        }
        // 多边形：边数任何入口都夹紧到 3–12；宽高下限与其它节点一致
        if (node.type === "polygon") {
          if (next.sides !== undefined) next.sides = clampSides(next.sides as number);
          if (next.width !== undefined) next.width = Math.max(1, next.width as number);
          if (next.height !== undefined) next.height = Math.max(1, next.height as number);
        }
        const prev: Record<string, unknown> = {};
        for (const key of Object.keys(next) as Array<keyof DocNode>) {
          if (key === "style") {
            prev[key] = { ...node.style };
            node.style = { ...(next.style as object) };
          } else {
            prev[key] = node[key];
            (node as unknown as Record<string, unknown>)[key] = next[key];
          }
        }
        changed.add(nodeId);
        return {
          cmd: { type: "node.update", params: { nodeId, patch: prev as Partial<DocNode> } },
        };
      }
      case "component.create":
        throw new Error("component.create 必须先展开");
      case "instance.resetOverride":
        throw new Error("instance.resetOverride 必须先展开");
      case "slot.create":
      case "slot.fill":
      case "slot.clear":
        throw new Error("插槽命令必须先展开");
      case "property.define":
      case "property.rename":
      case "property.delete":
      case "property.set":
        throw new Error("属性命令必须先展开");
      case "instance.swap":
      case "component.detach":
        throw new Error("实例生命周期命令必须先展开");
      case "node.reparent": {
        const { nodeId, parentId, index, x, y } = cmd.params;
        const node = this.state.nodes[nodeId];
        const oldParent = node?.parentId ? this.state.nodes[node.parentId] : null;
        if (!node || !oldParent) throw new Error(`节点 ${nodeId} 不存在或没有父级`);
        const oldIndex = oldParent.children.indexOf(nodeId);
        if (oldIndex < 0) throw new Error(`节点 ${nodeId} 的父子关系不一致`);
        const parent = this.state.nodes[parentId];
        if (!parent) throw new Error(`父节点 ${parentId} 不存在`);
        const oldX = node.x;
        const oldY = node.y;
        oldParent.children.splice(oldIndex, 1);
        const at = index ?? parent.children.length;
        parent.children.splice(at, 0, nodeId);
        node.parentId = parentId;
        if (x !== undefined) node.x = x;
        if (y !== undefined) node.y = y;
        changed.add(nodeId);
        changed.add(oldParent.id);
        changed.add(parent.id);
        return {
          cmd: {
            type: "node.reparent",
            params: { nodeId, parentId: oldParent.id, index: oldIndex, x: oldX, y: oldY },
          },
        };
      }
      case "instance.create": {
        const { componentId, parentId, nodeId, x, y, name } = cmd.params;
        const nodes = materializeInstance(this.state, componentId, nodeId, parentId, x, y, name);
        const parent = this.state.nodes[parentId];
        if (!parent) throw new Error(`父节点 ${parentId} 不存在`);
        for (const n of nodes) this.state.nodes[n.id] = n;
        parent.children.push(nodes[0].id);
        for (const n of nodes) changed.add(n.id);
        return { cmd: { type: "node.delete", params: { nodeId: nodes[0].id } } };
      }
      case "token.define": {
        const { path, tokenType, value } = cmd.params;
        const prevToken = this.state.tokens[path];
        this.state.tokens[path] = { type: tokenType, value };
        changed.add("__doc__" as NodeId);
        if (prevToken) {
          return {
            cmd: { type: "token.define", params: { path, tokenType: prevToken.type, value: prevToken.value } },
          };
        }
        // 新建 token 的逆：无原生命令表达"删除"，用同名空实现占位（骨架级）
        return { cmd: { type: "token.define", params: { path, tokenType, value } } };
      }
      case "token.rename": {
        const { from, to } = cmd.params;
        // 非法改名直接抛错：静默 no-op 会留下一条"撤销了却什么也没变"的历史
        if (from === to) throw new Error(`Token "${from}" 的目标路径与原名相同`);
        const entry = this.state.tokens[from];
        if (!entry) throw new Error(`Token "${from}" 不存在`);
        if (this.state.tokens[to]) throw new Error(`Token "${to}" 已存在，不能重命名`);

        delete this.state.tokens[from];
        this.state.tokens[to] = entry;

        // 引用随动：节点的填充/描边是仅有的两处 Paint 引用
        for (const node of Object.values(this.state.nodes)) {
          const style = node.style;
          let next: typeof style | null = null;
          if (style.fill?.token === from) next = { ...style, fill: { ...style.fill, token: to } };
          if (style.stroke?.token === from) next = { ...(next ?? style), stroke: { ...style.stroke, token: to } };
          if (next) {
            node.style = next;
            changed.add(node.id);
          }
        }
        changed.add("__doc__" as NodeId);
        return { cmd: { type: "token.rename", params: { from: to, to: from } } };
      }
    }
  }

  /** 整体替换文档（打开文件用）。 */
  replace(state: DocState): void {
    this.state = state;
    this.undoStack = [];
    this.redoStack = [];
    this.savedRevision = 0;
    this.emit(new Set());
  }

  /** 派生几何允许写回的字段：只限几何，不允许借道改样式/文本/结构。 */
  private static readonly DERIVED_KEYS = new Set(["x", "y", "width", "height"]);

  /**
   * 派生几何写回（如文本自动高度）：不进撤销栈，仍走同一套 applyOne 与布局 pass。
   * 只允许由宿主在测量完成后调用，且只接受 `node.update` 的几何字段。
   */
  applyDerived(cmds: Command | Command[]): void {
    const list = this.expand(Array.isArray(cmds) ? cmds : [cmds]);
    for (const cmd of list) {
      if (cmd.type !== "node.update") throw new Error("applyDerived 只接受 node.update");
      const keys = Object.keys(cmd.params.patch);
      if (keys.length === 0 || keys.some((key) => !DocStore.DERIVED_KEYS.has(key))) {
        throw new Error("applyDerived 只允许写回 x / y / width / height");
      }
    }
    const changed = new Set<NodeId>();
    for (const cmd of list) this.applyOne(cmd, changed);
    this.runLayoutPass(changed, []);
    if (changed.size > 0) {
      this.state.version += 1;
      this.emit(changed);
    }
  }

  snapshot(): DocState {
    return structuredClone(this.state);
  }
}
