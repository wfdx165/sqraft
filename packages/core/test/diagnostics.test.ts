/**
 * 写入后诊断：五个码的命中 / 不该命中，以及上限与去重。
 * 规则见 docs/specs/agent-diagnostics.md。
 */
import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, defaultLayoutSpec, firstPageId, newId, type DocNode, type NodeId } from "../src/model";
import { makeAnchor } from "../src/vector";
import { DocStore } from "../src/store";
import { diagnose, type DiagnosticCode } from "../src/diagnostics";

/** 桩度量：每个字符 10px（真实字体宽度由宿主注入）。 */
const measure = (text: string) => [...text].length * 10;

function setup() {
  const store = new DocStore(createDocWithPage());
  const pageId = firstPageId(store.doc)!;
  const add = (node: DocNode, parentId: NodeId | null): DocNode => {
    store.apply({ type: "node.create", params: { nodes: [node], parentId } }, "test");
    return node;
  };
  return { store, pageId, add };
}

function codesOf(store: DocStore, roots: NodeId[], options?: Parameters<typeof diagnose>[2]): DiagnosticCode[] {
  return diagnose(store.doc, roots, options).diagnostics.map((d) => d.code);
}

function idsOfCode(store: DocStore, roots: NodeId[], code: DiagnosticCode, options?: Parameters<typeof diagnose>[2]) {
  return diagnose(store.doc, roots, options)
    .diagnostics.filter((d) => d.code === code)
    .map((d) => d.nodeId);
}

describe("诊断：ZERO_SIZE", () => {
  it("零尺寸 / 负尺寸报，line、页面、有 vector 的路径不报", () => {
    const { store, pageId, add } = setup();
    const zero = add(createNode("rect", { name: "零宽", width: 0, height: 40 }), pageId);
    const negative = add(createNode("rect", { name: "负高", width: 20, height: -5 }), pageId);
    add(createNode("line", { name: "线", width: 1, height: 1 }), pageId);
    add(
      createNode("path", {
        name: "横线路径",
        width: 40,
        height: 0,
        vector: { closed: false, anchors: [makeAnchor(0, 0), makeAnchor(40, 0)] },
      }),
      pageId,
    );

    expect(idsOfCode(store, [pageId], "ZERO_SIZE").sort()).toEqual([zero.id, negative.id].sort());
  });
});

describe("诊断：TEXT_NO_FILL", () => {
  it("无填充文本报，带填充 / 空文本不报", () => {
    const { store, pageId, add } = setup();
    const naked = add(createNode("text", { name: "标题", text: "标题" }), pageId);
    add(createNode("text", { name: "有色", text: "标题", style: { fill: { value: "#111111" } } }), pageId);
    add(createNode("text", { name: "空白", text: "   " }), pageId);

    expect(idsOfCode(store, [pageId], "TEXT_NO_FILL")).toEqual([naked.id]);
  });

  it("悬空 fillToken 归 TOKEN_MISSING，不算无填充", () => {
    const { store, pageId, add } = setup();
    const node = add(
      createNode("text", { name: "标题", text: "标题", style: { fill: { token: "color/nope" } } }),
      pageId,
    );
    const codes = codesOf(store, [pageId]);
    expect(codes).toContain("TOKEN_MISSING");
    expect(codes).not.toContain("TEXT_NO_FILL");
    expect(idsOfCode(store, [pageId], "TOKEN_MISSING")).toEqual([node.id]);
  });
});

describe("诊断：TEXT_OVERFLOW", () => {
  const longText = "字".repeat(20);

  it("fixed 溢出报，auto-height 与 truncate:true 不报", () => {
    const { store, pageId, add } = setup();
    const fixed = add(
      createNode("text", {
        name: "定高",
        text: longText,
        width: 100,
        height: 10,
        textAutoResize: "fixed",
        style: { fill: { value: "#111111" } },
      }),
      pageId,
    );
    add(
      createNode("text", {
        name: "自适应高",
        text: longText,
        width: 100,
        height: 10,
        textAutoResize: "auto-height",
        style: { fill: { value: "#111111" } },
      }),
      pageId,
    );
    add(
      createNode("text", {
        name: "故意截断",
        text: longText,
        width: 100,
        height: 10,
        textAutoResize: "fixed",
        truncate: true,
        style: { fill: { value: "#111111" } },
      }),
      pageId,
    );

    expect(idsOfCode(store, [pageId], "TEXT_OVERFLOW", { measure })).toEqual([fixed.id]);
  });

  it("不传 measure 时整码跳过", () => {
    const { store, pageId, add } = setup();
    add(
      createNode("text", {
        name: "定高",
        text: longText,
        width: 100,
        height: 10,
        textAutoResize: "fixed",
        style: { fill: { value: "#111111" } },
      }),
      pageId,
    );
    expect(codesOf(store, [pageId])).not.toContain("TEXT_OVERFLOW");
  });
});

describe("诊断：TOKEN_MISSING", () => {
  it("颜色与数值引用都查，已定义的 Token 不报", () => {
    const { store, pageId, add } = setup();
    store.apply({ type: "token.define", params: { path: "color/ok", tokenType: "color", value: "#3366ff" } });
    store.apply({ type: "token.define", params: { path: "size/ok", tokenType: "number", value: 18 } });
    const colorBad = add(
      createNode("rect", { name: "坏色", style: { fill: { token: "color/missing" } } }),
      pageId,
    );
    const numberBad = add(
      createNode("text", { name: "坏字号", text: "hi", style: { fill: { token: "color/ok" }, fontSizeToken: "size/missing" } }),
      pageId,
    );
    add(
      createNode("rect", { name: "都正常", style: { fill: { token: "color/ok" }, strokeWidthToken: "size/ok" } }),
      pageId,
    );

    const diagnostics = diagnose(store.doc, [pageId]).diagnostics.filter((d) => d.code === "TOKEN_MISSING");
    expect(diagnostics).toHaveLength(2);
    expect(new Set(diagnostics.map((d) => d.nodeId))).toEqual(new Set([colorBad.id, numberBad.id]));
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Token "color/missing" is not defined.',
      'Token "size/missing" is not defined.',
    ]);
  });
});

describe("诊断：OUTSIDE_PARENT", () => {
  it("完全在父容器外报，部分伸出不报", () => {
    const { store, pageId, add } = setup();
    const frame = add(createNode("frame", { name: "画板", x: 0, y: 0, width: 200, height: 200 }), pageId);
    const far = add(createNode("rect", { name: "跑远了", x: 400, y: 0, width: 50, height: 50 }), frame.id);
    add(createNode("rect", { name: "角标", x: 180, y: 0, width: 50, height: 50 }), frame.id);

    expect(idsOfCode(store, [pageId], "OUTSIDE_PARENT")).toEqual([far.id]);
  });

  it("父容器有 padding 时按内容区判断；layoutAbsolute 子项不被布局搬走", () => {
    const { store, pageId, add } = setup();
    const frame = add(createNode("frame", { name: "画板", x: 0, y: 0, width: 200, height: 200 }), pageId);
    store.apply({
      type: "node.update",
      params: {
        nodeId: frame.id,
        patch: {
          layout: {
            ...defaultLayoutSpec(),
            padding: { top: 20, right: 20, bottom: 20, left: 20 },
          },
        },
      },
    });
    const absolute = add(
      createNode("rect", { name: "贴角", x: 0, y: 0, width: 10, height: 10, layoutAbsolute: true }),
      frame.id,
    );

    expect(idsOfCode(store, [pageId], "OUTSIDE_PARENT")).toEqual([absolute.id]);
  });

  it("group 父级与隐藏节点不报", () => {
    const { store, pageId, add } = setup();
    const a = add(createNode("rect", { name: "A", width: 40, height: 40 }), pageId);
    const b = add(createNode("rect", { name: "B", x: 60, width: 40, height: 40 }), pageId);
    store.apply({
      type: "node.group",
      params: { nodeIds: [a.id, b.id], groupId: newId() },
    });
    const groupId = store.doc.nodes[pageId].children[2];
    const farInGroup = add(createNode("rect", { name: "组里远处的", x: 10000, y: 10000, width: 10, height: 10 }), groupId);

    const frame = add(createNode("frame", { name: "画板", x: 0, y: 0, width: 100, height: 100 }), pageId);
    const hiddenFar = add(
      createNode("rect", { name: "隐藏的", x: 5000, y: 0, width: 10, height: 10, visible: false }),
      frame.id,
    );

    const ids = idsOfCode(store, [pageId], "OUTSIDE_PARENT");
    expect(ids).not.toContain(farInGroup.id);
    expect(ids).not.toContain(hiddenFar.id);
  });
});

describe("诊断：上限、去重、路径", () => {
  it("maxDiagnostics 截断并标记 truncated", () => {
    const { store, pageId, add } = setup();
    for (let i = 0; i < 30; i += 1) add(createNode("rect", { name: `零${i}`, width: 0, height: 0 }), pageId);
    const result = diagnose(store.doc, [pageId]);
    expect(result.diagnostics).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  it("maxNodes 截断并标记 truncated", () => {
    const { store, pageId, add } = setup();
    for (let i = 0; i < 5; i += 1) add(createNode("rect", { name: `零${i}`, width: 0, height: 0 }), pageId);
    const result = diagnose(store.doc, [pageId], { maxNodes: 2 });
    expect(result.truncated).toBe(true);
    expect(result.diagnostics.length).toBeLessThan(5);
  });

  it("祖先已在扫描根里时子节点只查一次", () => {
    const { store, pageId, add } = setup();
    const frame = add(createNode("frame", { name: "画板", width: 200, height: 200 }), pageId);
    const zero = add(createNode("rect", { name: "零宽", width: 0, height: 10 }), frame.id);

    const both = diagnose(store.doc, [frame.id, zero.id]).diagnostics.filter((d) => d.nodeId === zero.id);
    expect(both).toHaveLength(1);
  });

  it("名称链从页面到父节点，不含自己", () => {
    const { store, pageId, add } = setup();
    const card = add(createNode("frame", { name: "卡片", width: 200, height: 200 }), pageId);
    const zero = add(createNode("rect", { name: "缩略图", width: 0, height: 10 }), card.id);

    const diagnostic = diagnose(store.doc, [pageId]).diagnostics.find((d) => d.nodeId === zero.id)!;
    expect(diagnostic).toMatchObject({
      code: "ZERO_SIZE",
      nodeName: "缩略图",
      path: ["页面 1", "卡片"],
      severity: "warning",
    });
  });

  it("结果确定：同样输入两次结果一致；不可见根整棵跳过", () => {
    const { store, pageId, add } = setup();
    const hidden = add(createNode("frame", { name: "隐藏区", visible: false }), pageId);
    add(createNode("rect", { name: "零宽", width: 0, height: 10 }), hidden.id);

    expect(diagnose(store.doc, [pageId])).toEqual(diagnose(store.doc, [pageId]));
    expect(diagnose(store.doc, [hidden.id]).diagnostics).toEqual([]);
    expect(diagnose(store.doc, [pageId]).diagnostics).toEqual([]);
  });
});

describe("诊断：shallow（写工具用）", () => {
  it("只查根节点自身，不下探子树", () => {
    const { store, pageId, add } = setup();
    const frame = add(createNode("frame", { name: "画板", width: 200, height: 200 }), pageId);
    const zero = add(createNode("rect", { name: "零宽", width: 0, height: 10 }), frame.id);

    expect(diagnose(store.doc, [frame.id], { shallow: true }).diagnostics).toEqual([]);
    expect(diagnose(store.doc, [frame.id]).diagnostics.map((d) => d.nodeId)).toEqual([zero.id]);
  });

  it("多个根互为祖先时各自都查一次，不被去重吞掉", () => {
    const { store, pageId, add } = setup();
    const frame = add(createNode("frame", { name: "画板", width: 0, height: 200 }), pageId);
    const zero = add(createNode("rect", { name: "零宽", width: 0, height: 10 }), frame.id);

    const ids = diagnose(store.doc, [pageId, frame.id, zero.id], { shallow: true }).diagnostics.map(
      (d) => d.nodeId,
    );
    expect(ids.sort()).toEqual([frame.id, zero.id].sort());
  });

  it("隐藏子树不占扫描预算", () => {
    const { store, pageId, add } = setup();
    add(createNode("frame", { name: "隐藏区", visible: false, width: 200, height: 200 }), pageId);
    const a = add(createNode("rect", { name: "A", width: 0, height: 10 }), pageId);
    const b = add(createNode("rect", { name: "B", width: 0, height: 10 }), pageId);

    const result = diagnose(store.doc, [pageId], { maxNodes: 3 });
    expect(result.diagnostics.map((d) => d.nodeId).sort()).toEqual([a.id, b.id].sort());
    expect(result.truncated).toBe(false);
  });

  it("codes 白名单：只跑 TOKEN_MISSING 时不报其它码", () => {
    const { store, pageId, add } = setup();
    add(createNode("rect", { name: "零宽", width: 0, height: 10, style: { fill: { token: "color/nope" } } }), pageId);
    const codes = diagnose(store.doc, [pageId], { codes: ["TOKEN_MISSING"] }).diagnostics.map((d) => d.code);
    expect(new Set(codes)).toEqual(new Set(["TOKEN_MISSING"]));
  });
});
