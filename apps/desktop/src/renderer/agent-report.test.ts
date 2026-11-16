import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode } from "@sqraft/core";
import {
  actionOfTool,
  agentReport,
  buildAgentChanges,
  captureAgentPreNames,
  clearAgentReport,
  MAX_AGENT_CHANGES,
  parseAgentDiagnostics,
  setAgentReport,
} from "./agent-report";
import { docStore, replaceDocument, undo } from "./store";

describe("Agent 变更清单（R5）", () => {
  it("工具名映射到动作词，未知工具落到 update", () => {
    expect(actionOfTool("create_nodes")).toBe("create");
    expect(actionOfTool("delete_node")).toBe("delete");
    expect(actionOfTool("move_node")).toBe("move");
    expect(actionOfTool("set_instance_prop")).toBe("instance");
    expect(actionOfTool("define_token")).toBe("doc");
    expect(actionOfTool("随便什么")).toBe("update");
  });

  it("上限在遍历期生效：只分配 200 条，但总数仍是真实值", () => {
    const doc = createDocWithPage();
    const ids: string[] = [];
    for (let i = 0; i < MAX_AGENT_CHANGES + 5; i += 1) {
      const node = createNode("rect", { name: `节点 ${i}` });
      doc.nodes[node.id] = node;
      ids.push(node.id);
    }

    const report = buildAgentChanges(doc, ids, new Map(), "create_node");
    expect(report.changes).toHaveLength(MAX_AGENT_CHANGES);
    expect(report.total).toBe(MAX_AGENT_CHANGES + 5);

    setAgentReport(report, []);
    expect(agentReport.changes).toHaveLength(MAX_AGENT_CHANGES);
    expect(agentReport.total).toBe(MAX_AGENT_CHANGES + 5);

    clearAgentReport();
    expect(agentReport.changes).toHaveLength(0);
    expect(agentReport.diagnostics).toHaveLength(0);
    expect(agentReport.total).toBe(0);
  });

  it("清单只收能叫出名字的：文档级哨兵不是节点，直接丢掉", () => {
    const doc = createDocWithPage();
    const rect = createNode("rect", { name: "矩形" });
    doc.nodes[rect.id] = rect;
    const ids = [rect.id, "__doc__" as string, "NUMERIC_TOKEN_CHANGED" as string, "幽灵节点"];

    const report = buildAgentChanges(doc, ids, new Map(), "create_node");
    expect(report.changes).toEqual([{ nodeId: rect.id, nodeName: "矩形", action: "create" }]);
    expect(report.total).toBe(1);
  });

  it("删除前抄下的名字仍在：删完的子树不会显示成一串 id", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const group = createNode("frame", { name: "卡片" });
    doc.nodes[group.id] = group;
    group.parentId = pageId;
    const label = createNode("text", { name: "标题" });
    doc.nodes[label.id] = label;
    label.parentId = group.id;
    label.children = [];
    group.children = [label.id];

    // 调用前：delete_node 的入参点到 group，整棵子树都要抄
    const preNames = captureAgentPreNames(doc, "delete_node", { nodeId: group.id });
    expect(preNames.get(group.id)).toBe("卡片");
    expect(preNames.get(label.id)).toBe("标题");

    // 调用后：子树已从文档里消失，清单仍用调用前的名字
    delete doc.nodes[group.id];
    delete doc.nodes[label.id];
    const report = buildAgentChanges(doc, [group.id, label.id], preNames, "delete_node");
    expect(report.changes).toEqual([
      { nodeId: group.id, nodeName: "卡片", action: "delete" },
      { nodeId: label.id, nodeName: "标题", action: "delete" },
    ]);
  });

  it("诊断从工具响应里解析；没有或解析失败都当没有", () => {
    const value = JSON.stringify({
      ok: true,
      diagnostics: [{ code: "TEXT_OVERFLOW", nodeId: "n1", nodeName: "标题" }],
    });
    expect(parseAgentDiagnostics(value)).toEqual([
      { code: "TEXT_OVERFLOW", nodeId: "n1", nodeName: "标题" },
    ]);
    expect(parseAgentDiagnostics(undefined)).toEqual([]);
    expect(parseAgentDiagnostics("not json")).toEqual([]);
    expect(parseAgentDiagnostics('{"ok":true}')).toEqual([]);
  });

  it("撤销立即清空清单（撤销后不能指向已回退的节点）", () => {
    docStore.replace(createDocWithPage());
    const pageId = docStore.doc.rootIds[0];
    const rect = createNode("rect", { name: "矩形" });
    docStore.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });

    setAgentReport(
      { changes: [{ nodeId: rect.id, nodeName: "矩形", action: "create" }], total: 1 },
      [{ code: "ZERO_SIZE", nodeId: rect.id, nodeName: "矩形" }],
    );

    undo();
    expect(docStore.doc.nodes[rect.id]).toBeUndefined();
    expect(agentReport.changes).toHaveLength(0);
    expect(agentReport.diagnostics).toHaveLength(0);
    expect(agentReport.total).toBe(0);
  });

  it("空撤销栈上按 ⌘Z 不清清单（什么都没撤销，清单仍然有效）", () => {
    docStore.replace(createDocWithPage());
    setAgentReport({ changes: [{ nodeId: "keep", nodeName: "仍然有效", action: "update" }], total: 1 }, []);

    undo();
    expect(agentReport.changes).toHaveLength(1);
  });

  it("换文档时清空清单（新建 / 打开 / 关闭都走 replaceDocument）", () => {
    setAgentReport({ changes: [{ nodeId: "gone", nodeName: "旧稿节点", action: "create" }], total: 1 }, [
      { code: "ZERO_SIZE", nodeId: "gone", nodeName: "旧稿节点" },
    ]);

    replaceDocument(createDocWithPage());
    expect(agentReport.changes).toHaveLength(0);
    expect(agentReport.diagnostics).toHaveLength(0);
    expect(agentReport.total).toBe(0);
  });
});
