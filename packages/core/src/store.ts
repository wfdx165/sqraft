/**
 * 命令系统：文档变更的唯一入口（ADR-0001）。
 * 确定性 + 可逆 + 可批量；GUI、AI、撤销重做全部走这里。
 */

import type { DocNode, DocState, NodeId } from "./model";
import { walkSubtree } from "./model";

export type Command =
  | { type: "node.create"; params: { nodes: DocNode[]; parentId: NodeId | null; index?: number } }
  | { type: "node.delete"; params: { nodeId: NodeId } }
  | { type: "node.update"; params: { nodeId: NodeId; patch: Partial<DocNode> } }
  | { type: "token.define"; params: { path: string; tokenType: "color" | "number"; value: string | number } }
  /** 改名是原子操作：token 条目与所有节点引用一起改，只占一步撤销 */
  | { type: "token.rename"; params: { from: string; to: string } };

interface Inverse {
  cmd: Command;
  /** node.delete 的逆需要子树快照 */
  snapshot?: DocNode[];
}

export type ChangeListener = (state: DocState, changedIds: Set<NodeId>) => void;

export class DocStore {
  private state: DocState;
  private undoStack: Array<{ label: string; inverses: Inverse[] }> = [];
  private redoStack: Array<{ label: string; inverses: Inverse[] }> = [];
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

  /** 应用一条或一批命令（原子）；自动记录逆命令供撤销。 */
  apply(cmds: Command | Command[], label = "edit"): void {
    const list = Array.isArray(cmds) ? cmds : [cmds];
    const inverses: Inverse[] = [];
    const changed = new Set<NodeId>();
    for (const cmd of list) {
      inverses.unshift(this.applyOne(cmd, changed));
    }
    if (inverses.length > 0) {
      this.undoStack.push({ label, inverses });
      this.redoStack = [];
      this.state.version += 1;
      this.emit(changed);
    }
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const changed = new Set<NodeId>();
    const forward: Inverse[] = [];
    for (const inv of entry.inverses) {
      forward.unshift(this.applyOne(inv.cmd, changed, inv.snapshot));
    }
    this.redoStack.push({ label: entry.label, inverses: forward });
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
    this.undoStack.push({ label: entry.label, inverses: back });
    this.state.version += 1;
    this.emit(changed);
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private applyOne(cmd: Command, changed: Set<NodeId>, snapshot?: DocNode[]): Inverse {
    switch (cmd.type) {
      case "node.create": {
        const { nodes, parentId, index } = cmd.params;
        for (const n of nodes) {
          this.state.nodes[n.id] = { ...n };
        }
        const parent = parentId ? this.state.nodes[parentId] : null;
        const rootId = nodes[0].id;
        if (parent) {
          const at = index ?? parent.children.length;
          parent.children.splice(at, 0, rootId);
          nodes[0].parentId = parent.id;
          this.state.nodes[rootId].parentId = parent.id;
        } else {
          this.state.rootIds.push(rootId);
        }
        for (const n of nodes) changed.add(n.id);
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
        for (const n of removed) {
          delete this.state.nodes[n.id];
          changed.add(n.id);
        }
        // 逆命令：重建子树（removed 为前序快照，parentId 指向原父）
        const rebuild = removed.map((n, i) => (i === 0 ? { ...n, parentId } : n));
        return { cmd: { type: "node.create", params: { nodes: rebuild, parentId, index } } };
      }
      case "node.update": {
        const { nodeId, patch } = cmd.params;
        const node = this.state.nodes[nodeId];
        if (!node) return { cmd: { type: "node.update", params: { nodeId, patch: {} } } };
        const prev: Record<string, unknown> = {};
        for (const key of Object.keys(patch) as Array<keyof DocNode>) {
          if (key === "style") {
            prev[key] = { ...node.style };
            node.style = { ...(patch.style as object) };
          } else {
            prev[key] = node[key];
            (node as unknown as Record<string, unknown>)[key] = patch[key];
          }
        }
        changed.add(nodeId);
        return {
          cmd: { type: "node.update", params: { nodeId, patch: prev as Partial<DocNode> } },
        };
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
    this.emit(new Set());
  }

  snapshot(): DocState {
    return structuredClone(this.state);
  }
}
