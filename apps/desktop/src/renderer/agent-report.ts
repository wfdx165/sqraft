/**
 * Agent 变更清单（第 2 波 R5）：一次 MCP 写调用改了哪些节点、诊断说了什么。
 *
 * 纯 UI 状态，不进 `.sqraft`。数据源是写调用窗口内累积的 `changed` 集合
 * （`mcp-host.ts` 的 `collecting`）——比让工具再返回一份更可靠：
 * 布局回写、实例物化这些被动改动也会被同一个订阅收进来。
 *
 * 生命周期：保留到下一次调用覆盖；**撤销 / 重做立即清空**——撤销是全局的，
 * 清单留着就会指向已经回退掉的节点，"点击定位"会跳到不存在的东西上。
 */
import { reactive } from "vue";
import { walkSubtree, type DocState, type NodeId } from "@sqraft/core";

export type AgentAction = "create" | "update" | "delete" | "move" | "instance" | "doc";

export interface AgentChange {
  nodeId: NodeId;
  nodeName: string;
  action: AgentAction;
}

export interface AgentDiagnostic {
  code: string;
  nodeId: NodeId;
  nodeName: string;
}

/** `buildAgentChanges` 的结果：`changes` 已按上限截断，`total` 是真实条数。 */
export interface AgentChangeReport {
  changes: AgentChange[];
  total: number;
}

/** 工具名 → 清单里的动作词。读工具不会走到这里（只在写调用窗口内累积）。 */
const ACTION_BY_TOOL: Record<string, AgentAction> = {
  create_node: "create",
  create_nodes: "create",
  create_page: "create",
  group_nodes: "create",
  duplicate_node: "create",
  delete_node: "delete",
  move_node: "move",
  update_node: "update",
  arrange_nodes: "update",
  create_instance: "instance",
  define_property: "instance",
  set_instance_prop: "instance",
  fill_slot: "instance",
  swap_instance: "instance",
  detach_instance: "instance",
  define_token: "doc",
  rename_token: "doc",
  delete_token: "doc",
};

export function actionOfTool(tool: string): AgentAction {
  return ACTION_BY_TOOL[tool] ?? "update";
}

/** 单次清单的上限：诊断在 core 里已有 20 条上限，改动没有上限时一次布局回写能刷出几百行。 */
export const MAX_AGENT_CHANGES = 200;

export const agentReport = reactive({
  changes: [] as AgentChange[],
  diagnostics: [] as AgentDiagnostic[],
  /** 本次改动的真实总数；大于 changes.length 说明被 MAX_AGENT_CHANGES 截断了 */
  total: 0,
});

export function setAgentReport(report: AgentChangeReport, diagnostics: AgentDiagnostic[]): void {
  agentReport.changes = report.changes;
  agentReport.total = report.total;
  agentReport.diagnostics = diagnostics;
}

export function clearAgentReport(): void {
  agentReport.changes = [];
  agentReport.diagnostics = [];
  agentReport.total = 0;
}

/**
 * 调用前把入参点到的节点名记下来。
 * 删除类工具会把名字一起从文档里带走，清单要在那之前先抄一份
 * （`delete_node` 连整棵子树一起删，所以子树里的每个节点都要记）。
 */
export function captureAgentPreNames(
  doc: DocState,
  tool: string,
  args: Record<string, unknown>,
): Map<NodeId, string> {
  const out = new Map<NodeId, string>();
  const take = (value: unknown): void => {
    if (typeof value !== "string") return;
    const node = doc.nodes[value];
    if (node) out.set(value, node.name);
  };
  take(args.nodeId);
  if (Array.isArray(args.nodeIds)) for (const id of args.nodeIds) take(id);
  if (tool === "delete_node" && typeof args.nodeId === "string" && doc.nodes[args.nodeId]) {
    walkSubtree(doc, args.nodeId, (node) => out.set(node.id, node.name));
  }
  return out;
}

/**
 * 把调用窗口里累积的改动落成清单。
 * 只留能叫出名字的：文档级哨兵（`__doc__`、`NUMERIC_TOKEN_CHANGED`）不是节点，
 * 没名字的行在界面上只会显示成一串 id。
 *
 * **上限在遍历期生效**：`collecting` 是大稿上一次布局回写后的全量 changed（可达数万），
 * 先建全量数组再 slice 等于在渲染层主线程上白分配几万个对象。计数不分配，只截数组。
 */
export function buildAgentChanges(
  doc: DocState,
  ids: Iterable<NodeId>,
  preNames: ReadonlyMap<NodeId, string>,
  tool: string,
): AgentChangeReport {
  const action = actionOfTool(tool);
  const changes: AgentChange[] = [];
  let total = 0;
  for (const id of ids) {
    const name = doc.nodes[id]?.name ?? preNames.get(id);
    if (name === undefined) continue;
    total += 1;
    if (changes.length < MAX_AGENT_CHANGES) changes.push({ nodeId: id, nodeName: name, action });
  }
  return { changes, total };
}

/** 工具响应里的诊断与改动并列返回（见 `attachDiagnostics`）；解析失败当没有。 */
export function parseAgentDiagnostics(value: string | undefined): AgentDiagnostic[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { diagnostics?: Array<Record<string, unknown>> };
    if (!Array.isArray(parsed.diagnostics)) return [];
    return parsed.diagnostics.map((d) => ({
      code: String(d.code ?? ""),
      nodeId: String(d.nodeId ?? ""),
      nodeName: String(d.nodeName ?? ""),
    }));
  } catch {
    return [];
  }
}
