import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocWithPage, createNode, firstPageId } from "@sqraft/core";

// 图片仓库在测试里只需要"已存在/注册成功"，解码属于 assets 自己的测试
const assetState = vi.hoisted(() => ({
  assets: [] as Array<{ id: string; mime: string; bytes: Uint8Array; url: string }>,
}));
vi.mock("../assets", () => ({
  MAX_ASSET_BYTES: 20 * 1024 * 1024,
  allAssets: () => assetState.assets,
  hasAsset: () => true,
  putAsset: vi.fn(async () => ({ ok: false, reason: "test" })),
}));

let clipboard = "";
const bridge = {
  dialog: { error: vi.fn(async () => {}) },
  app: {
    writeClipboardNodes: vi.fn(async (json: string) => {
      clipboard = json;
    }),
    readClipboardNodes: vi.fn(async () => (clipboard ? clipboard : null)),
  },
};
vi.stubGlobal("window", { sqraft: bridge });

const { docStore, select, ui } = await import("../store");
const { copySelectionToClipboard, pasteNodesFromClipboard } = await import("./node-clipboard");

const deps = (pointer: { x: number; y: number } | null, container: string | null = null) => ({
  pointerWorld: () => pointer,
  activePageId: () => firstPageId(docStore.doc),
  pageAt: () => firstPageId(docStore.doc),
  containerAt: () => (container ? docStore.doc.nodes[container] ?? null : null),
});

describe("节点剪贴板", () => {
  let pageId: string;

  beforeEach(() => {
    clipboard = "";
    docStore.replace(createDocWithPage());
    pageId = firstPageId(docStore.doc)!;
    ui.selection = [];
  });

  function addRect(x: number, y: number) {
    const node = createNode("rect", { parentId: pageId, x, y, width: 10, height: 10 });
    docStore.apply({ type: "node.create", params: { nodes: [node], parentId: pageId } });
    return node;
  }

  it("复制 → 粘贴：新 id、原位 +10px、同父级", async () => {
    const rect = addRect(5, 6);
    select([rect.id]);
    expect(await copySelectionToClipboard()).toBe(true);

    expect(await pasteNodesFromClipboard(deps(null))).toBe(true);
    const copy = docStore.doc.nodes[ui.selection[0]];
    expect(copy.id).not.toBe(rect.id);
    expect(copy.parentId).toBe(pageId);
    expect([copy.x, copy.y]).toEqual([15, 16]);
    expect(ui.selection).toEqual([copy.id]);
  });

  it("指针在画布上时粘到指针处", async () => {
    const rect = addRect(5, 6);
    select([rect.id]);
    await copySelectionToClipboard();
    await pasteNodesFromClipboard(deps({ x: 120, y: 80 }));
    const copy = docStore.doc.nodes[ui.selection[0]];
    expect([copy.x, copy.y]).toEqual([120, 80]);
  });

  it("指针在容器里时父级取该容器，坐标相对容器", async () => {
    const frame = createNode("frame", { parentId: pageId, x: 100, y: 50, width: 200, height: 100 });
    docStore.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    const rect = addRect(5, 6);
    select([rect.id]);
    await copySelectionToClipboard();

    await pasteNodesFromClipboard(deps({ x: 150, y: 90 }, frame.id));
    const copy = docStore.doc.nodes[ui.selection[0]];
    expect(copy.parentId).toBe(frame.id);
    expect([copy.x, copy.y]).toEqual([50, 40]);
  });

  it("整棵子树一起复制，子节点指向副本父级", async () => {
    const frame = createNode("frame", { parentId: pageId, x: 10, y: 10, width: 100, height: 100 });
    const child = createNode("rect", { parentId: frame.id, x: 5, y: 5, width: 10, height: 10 });
    frame.children = [child.id];
    docStore.apply({ type: "node.create", params: { nodes: [frame, child], parentId: pageId } });
    select([frame.id]);
    await copySelectionToClipboard();

    await pasteNodesFromClipboard(deps(null));
    const copy = docStore.doc.nodes[ui.selection[0]];
    expect(copy.children).toHaveLength(1);
    const childCopy = docStore.doc.nodes[copy.children[0]];
    expect(childCopy.parentId).toBe(copy.id);
    expect(childCopy.id).not.toBe(child.id);
    expect([childCopy.x, childCopy.y]).toEqual([5, 5]);
  });

  it("超限图片不内联：节点照常粘贴，图降级为占位", async () => {
    assetState.assets = [
      { id: "big", mime: "image/png", bytes: new Uint8Array(20 * 1024 * 1024 + 1), url: "" },
    ];
    const image = createNode("image", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      image: { assetId: "big", naturalWidth: 10, naturalHeight: 10, crop: { x: 0, y: 0, width: 10, height: 10 } },
    });
    docStore.apply({ type: "node.create", params: { nodes: [image], parentId: pageId } });
    select([image.id]);
    await copySelectionToClipboard();

    expect(JSON.parse(clipboard).assets.big).toBeUndefined();
    await pasteNodesFromClipboard(deps(null));
    expect(docStore.doc.nodes[ui.selection[0]].image?.assetId).toBe("big");
    assetState.assets = [];
  });

  it("畸形节点被丢弃，指向它的引用一起剪断", async () => {
    clipboard = JSON.stringify({
      kind: "sqraft/nodes",
      version: 1,
      rootIds: ["ok", "bad"],
      nodes: [
        { ...createNode("frame", { id: "ok", x: 0, y: 0, width: 10, height: 10 }), children: ["bad"] },
        { id: "bad", type: "rect", x: "不是数字", y: 0, width: 10, height: 10, style: {} },
      ],
      tokens: {},
      assets: {},
    });
    expect(await pasteNodesFromClipboard(deps(null))).toBe(true);
    const pasted = docStore.doc.nodes[ui.selection[0]];
    expect(pasted.children).toEqual([]);
    expect(Object.values(docStore.doc.nodes).some((n) => n.type === "rect")).toBe(false);
  });

  it("全是畸形节点时提示并拒绝", async () => {
    clipboard = JSON.stringify({
      kind: "sqraft/nodes",
      version: 1,
      rootIds: ["bad"],
      nodes: [{ id: "bad", type: "rect" }],
      tokens: {},
      assets: {},
    });
    bridge.dialog.error.mockClear();
    expect(await pasteNodesFromClipboard(deps(null))).toBe(true);
    expect(bridge.dialog.error).toHaveBeenCalledTimes(1);
    expect(docStore.doc.nodes[pageId].children).toEqual([]);
  });

  it("剪贴板里没有 sqraft 载荷时返回 false（让位给图片/文本）", async () => {
    expect(await pasteNodesFromClipboard(deps(null))).toBe(false);
  });

  it("载荷版本不认识时提示并拒绝粘贴", async () => {
    clipboard = JSON.stringify({ kind: "sqraft/nodes", version: 99, rootIds: [], nodes: [] });
    bridge.dialog.error.mockClear();
    expect(await pasteNodesFromClipboard(deps(null))).toBe(true);
    expect(bridge.dialog.error).toHaveBeenCalledTimes(1);
    expect(docStore.doc.nodes[pageId].children).toEqual([]);
  });

  it("目标文档缺的 Token 连定义一起补上，且与节点同一条撤销", async () => {
    clipboard = JSON.stringify({
      kind: "sqraft/nodes",
      version: 1,
      rootIds: ["r1"],
      nodes: [
        {
          ...createNode("rect", { id: "r1", x: 0, y: 0, width: 10, height: 10 }),
          style: { fill: { token: "color/brand" } },
        },
      ],
      tokens: { "color/brand": { type: "color", value: "#222222" } },
      assets: {},
    });

    expect(await pasteNodesFromClipboard(deps(null))).toBe(true);
    expect(docStore.doc.tokens["color/brand"]).toEqual({ type: "color", value: "#222222" });

    docStore.undo();
    expect(docStore.doc.tokens["color/brand"]).toBeUndefined();
    expect(docStore.doc.nodes[pageId].children).toEqual([]);
  });

  it("同名 Token 冲突时保留目标文档的值", async () => {
    docStore.apply(
      { type: "token.define", params: { path: "color/brand", tokenType: "color", value: "#111111" } },
      "token",
    );
    clipboard = JSON.stringify({
      kind: "sqraft/nodes",
      version: 1,
      rootIds: ["r1"],
      nodes: [createNode("rect", { id: "r1", x: 0, y: 0, width: 10, height: 10 })],
      tokens: { "color/brand": { type: "color", value: "#222222" } },
      assets: {},
    });

    await pasteNodesFromClipboard(deps(null));
    expect(docStore.doc.tokens["color/brand"].value).toBe("#111111");
  });

  it("实例的母版不在目标文档时降级为画板", async () => {
    clipboard = JSON.stringify({
      kind: "sqraft/nodes",
      version: 1,
      rootIds: ["i1"],
      nodes: [
        {
          ...createNode("instance", { id: "i1", x: 0, y: 0, width: 100, height: 100 }),
          componentId: "missing-master",
          mainId: "missing-master",
          propValues: { p1: "x" },
          overrides: { "missing-master": { x: 1 } },
          children: ["i2"],
        },
        {
          ...createNode("rect", { id: "i2", parentId: "i1", x: 0, y: 0, width: 10, height: 10 }),
          mainId: "missing-master",
        },
      ],
      tokens: {},
      assets: {},
    });

    expect(await pasteNodesFromClipboard(deps(null))).toBe(true);
    const pasted = docStore.doc.nodes[ui.selection[0]];
    expect(pasted.type).toBe("frame");
    expect(pasted.componentId).toBeUndefined();
    expect(pasted.overrides).toBeUndefined();
    const child = docStore.doc.nodes[pasted.children[0]];
    expect(child.mainId).toBeUndefined();
  });
});
