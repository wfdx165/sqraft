/**
 * 原型链接：校验与归一化。
 *
 * 规则集中在核心层，GUI 与 agent 共用同一套（与「边数夹紧」同类）：
 * - 只能挂在页面子树里的节点上；主组件、实例子孙里没有播放环境，直接拒绝；
 * - 目标必须是页面；不能指向自己所在的页面（等于原地跳转）；
 * - 数组整组替换，id 在节点内唯一，最多 8 条；
 * - 时长夹到合法区间，非法值抛错而不是静默改写。
 */
import type { DocNode, DocState, Interaction, InteractionTransition, NodeId } from "./model";
import { walkSubtree } from "./model";

export const MAX_INTERACTIONS = 8;
export const MIN_DISSOLVE_MS = 60;
export const MAX_DISSOLVE_MS = 2000;
export const DEFAULT_DISSOLVE_MS = 200;

const ACTIONS = new Set(["navigate", "back"]);
const TRANSITIONS = new Set(["instant", "dissolve"]);

/** 同一批命令里先创建、后引用的节点（apply 期还不存在）。 */
export type PendingTypes = ReadonlyMap<NodeId, DocNode["type"]>;

/** 写入校验的可选上下文。 */
export interface NormalizeOptions {
  /** 同一批命令里已经创建的节点类型。 */
  pending?: PendingTypes;
  /**
   * 这批命令里新建节点的祖先链。复制/粘贴整页时节点还没落进文档，
   * `isAncestorOf` 走不了父级链，只能由调用方把链带进来。
   */
  ancestors?: readonly NodeId[];
  /**
   * 同一批命令里会被删除的页面。展开阶段只清理"删除页面前已经存在"的链接，
   * 同一批里"先删页、后加链接"的那条只能在这里拦下，否则会留下指向已删页面的死链。
   */
  deletedTargets?: ReadonlySet<NodeId>;
}

function targetTypeOf(state: DocState, targetId: NodeId, pending?: PendingTypes): DocNode["type"] | undefined {
  return state.nodes[targetId]?.type ?? pending?.get(targetId);
}

function isAncestorOf(state: DocState, ancestorId: NodeId, nodeId: NodeId): boolean {
  let cur = state.nodes[nodeId]?.parentId;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = state.nodes[cur]?.parentId ?? null;
  }
  return false;
}

/** 节点祖先链上是否有页面（含自身是页面）。 */
export function isInPageSubtree(state: DocState, nodeId: NodeId): boolean {
  let cur: DocNode | undefined = state.nodes[nodeId];
  while (cur) {
    if (cur.type === "page") return true;
    cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
  }
  return false;
}

/** 严格位于实例内部（实例根本身不算）。 */
export function hasInstanceAncestor(state: DocState, nodeId: NodeId): boolean {
  let cur = state.nodes[nodeId]?.parentId;
  while (cur) {
    const node = state.nodes[cur];
    if (node?.type === "instance") return true;
    cur = node?.parentId ?? null;
  }
  return false;
}

/** 页面子树之外的节点不能持有链接（主组件、文档根、实例内部）。 */
export function assertLinkPlacement(state: DocState, nodeId: NodeId): void {
  const node = state.nodes[nodeId];
  if (!node) throw new Error(`节点 ${nodeId} 不存在`);
  if (node.type === "page") throw new Error("页面是链接的目标，不能自己持有链接");
  if (!isInPageSubtree(state, nodeId)) throw new Error("原型链接只能挂在页面里的图层上");
  if (hasInstanceAncestor(state, nodeId)) throw new Error("实例内部的图层不能单独挂链接");
}

function normalizeTransition(raw: InteractionTransition | undefined): InteractionTransition {
  if (!raw || typeof raw !== "object") throw new Error("原型链接缺少转场设置");
  if (!TRANSITIONS.has(raw.type)) throw new Error(`未知的转场类型：${String(raw.type)}`);
  if (raw.type === "instant") return { type: "instant", durationMs: 0 };
  const duration = Number(raw.durationMs);
  if (!Number.isFinite(duration)) throw new Error("转场时长必须是数字");
  return {
    type: "dissolve",
    durationMs: Math.min(MAX_DISSOLVE_MS, Math.max(MIN_DISSOLVE_MS, Math.round(duration))),
  };
}

/**
 * 校验并归一化一组链接；返回写入文档的副本（不改调用方数组）。
 * `undefined` 表示清空。
 */
export function normalizeInteractions(
  state: DocState,
  nodeId: NodeId,
  value: Interaction[] | undefined,
  options?: NormalizeOptions,
): Interaction[] | undefined {
  const pending = options?.pending;
  const ancestors = options?.ancestors;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("interactions 必须是数组");
  if (value.length > MAX_INTERACTIONS) throw new Error(`一个图层最多 ${MAX_INTERACTIONS} 条原型链接`);

  const seen = new Set<string>();
  const out: Interaction[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") throw new Error("原型链接条目格式不正确");
    const id = String(raw.id ?? "");
    if (!id) throw new Error("原型链接缺少 id");
    if (seen.has(id)) throw new Error(`原型链接 id 重复：${id}`);
    seen.add(id);
    if (raw.trigger !== "click") throw new Error(`未知的触发方式：${String(raw.trigger)}`);
    if (!ACTIONS.has(raw.action)) throw new Error(`未知的链接动作：${String(raw.action)}`);

    if (raw.action === "back") {
      // 返回是出栈，没有转场参数：统一收敛为 instant，避免 list_interactions 里出现无意义的时长
      out.push({ id, trigger: "click", action: "back", transition: { type: "instant", durationMs: 0 } });
      continue;
    }

    const targetId = raw.targetId;
    if (!targetId) throw new Error("跳转链接缺少目标页面");
    const type = targetTypeOf(state, targetId, pending);
    if (!type) throw new Error(`目标页面 ${targetId} 不存在`);
    if (type !== "page") throw new Error("跳转目标必须是页面");
    if (options?.deletedTargets?.has(targetId)) throw new Error("跳转目标页面会在同一批命令里被删除");
    if (targetId === nodeId) throw new Error("跳转目标不能是图层自身");
    if (isAncestorOf(state, targetId, nodeId) || ancestors?.includes(targetId)) {
      throw new Error("不能跳到自己所在的页面");
    }
    out.push({
      id,
      trigger: "click",
      action: "navigate",
      targetId,
      transition: normalizeTransition(raw.transition),
    });
  }
  return out.length ? out : undefined;
}

/** 换父级离开页面子树时，需要清掉链接的节点（含自身）。 */
export function linkStripTargets(doc: DocState, nodeId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  walkSubtree(doc, nodeId, (node) => {
    if (node.interactions?.length) out.push(node.id);
  });
  return out;
}

/**
 * 删除页面前要清理的入站链接：返回节点与清理后的数组。
 * `interactions` 为 undefined 表示整组清空。
 */
export function linkCleanupForPage(
  doc: DocState,
  pageId: NodeId,
): Array<{ nodeId: NodeId; interactions: Interaction[] | undefined }> {
  const out: Array<{ nodeId: NodeId; interactions: Interaction[] | undefined }> = [];
  for (const node of Object.values(doc.nodes)) {
    if (!node.interactions?.some((link) => link.targetId === pageId)) continue;
    const next = node.interactions.filter((link) => link.targetId !== pageId);
    out.push({ nodeId: node.id, interactions: next.length ? next : undefined });
  }
  return out;
}
