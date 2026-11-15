/**
 * 大文档读取体积回归：10 万节点下「单页一层」必须远小于全量读取。
 *
 * fixture 直接拼 DocState 再 new DocStore —— 不能逐节点 store.apply：
 * apply 里有 O(全表) 的组件与 Token 扫描，10 万次会退化成 O(N²)。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyDoc, createNode, DocStore, firstPageId, type DocNode, type DocState } from "@sqraft/core";
import { makeExecutor, type ToolExecutor } from "../src/index";

const PAGES = 100;
const FRAMES_PER_PAGE = 100;
const LEAVES_PER_FRAME = 9;
/** 页面 → 100 个 frame → 每个 9 个文本叶子 */
const NODES_PER_PAGE = 1 + FRAMES_PER_PAGE * (1 + LEAVES_PER_FRAME);

function makeBigDoc(): DocState {
  const doc = createEmptyDoc();
  const add = (node: DocNode, parent?: DocNode): void => {
    doc.nodes[node.id] = node;
    if (parent) parent.children.push(node.id);
    else doc.rootIds.push(node.id);
  };
  for (let p = 0; p < PAGES; p += 1) {
    const page = createNode("page", {
      name: `Page ${p}`,
      x: p * 1600,
      width: 1440,
      height: 1024,
    });
    add(page);
    for (let f = 0; f < FRAMES_PER_PAGE; f += 1) {
      const frame = createNode("frame", {
        name: `Card ${p}-${f}`,
        parentId: page.id,
        x: (f % 10) * 140,
        y: Math.floor(f / 10) * 200,
        width: 120,
        height: 180,
      });
      add(frame, page);
      for (let l = 0; l < LEAVES_PER_FRAME; l += 1) {
        const leaf = createNode("text", {
          name: `Label ${l}`,
          parentId: frame.id,
          x: 8,
          y: 8 + l * 16,
          width: 100,
          height: 14,
          text: `Item ${l}`,
        });
        add(leaf, frame);
      }
    }
  }
  return doc;
}

// 10 万节点的构造放在 beforeAll：模块加载期不付出 ~100MB 内存与 100ms 构建成本
let store: DocStore;
let pageId: string;
let run: ToolExecutor;

beforeAll(() => {
  store = new DocStore(makeBigDoc());
  pageId = firstPageId(store.doc)!;
  run = makeExecutor(store, async () => "", () => pageId);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  return JSON.parse(await run(name, args)) as Record<string, unknown>;
}

/** 节点 id → 所属页面（用于断言没有跨页泄漏）。 */
function pageOfNode(id: string): string | null {
  let cur: string | null = id;
  while (cur) {
    const node: DocNode | undefined = store.doc.nodes[cur];
    if (!node) return null;
    if (node.type === "page") return node.id;
    cur = node.parentId;
  }
  return null;
}

describe("大文档：read_document 体积", () => {
  it("fixture 规模符合预期（10 万节点）", () => {
    expect(Object.keys(store.doc.nodes)).toHaveLength(PAGES * NODES_PER_PAGE);
    expect(store.doc.nodes[pageId].children).toHaveLength(FRAMES_PER_PAGE);
  });

  it("默认读取（当前页一层）体积受控", async () => {
    const raw = await run("read_document", {});
    const doc = JSON.parse(raw) as { nodes: Array<{ id: string; depth: number }> };
    expect(doc.nodes).toHaveLength(1 + FRAMES_PER_PAGE);
    expect(doc.nodes.every((n) => n.depth <= 1)).toBe(true);
    expect(raw.length).toBeLessThanOrEqual(48 * 1024);

    // 全量读取 = 同一形状的 100 个页面各自读到底
    const perPage = (await run("read_document", { scope: "page", pageId, depth: 8 })).length;
    expect(raw.length / (perPage * PAGES)).toBeLessThanOrEqual(0.01);
  });

  it("返回的 id 全部属于当前页", async () => {
    const doc = await call("read_document");
    const ids = (doc.nodes as Array<{ id: string }>).map((n) => n.id);
    expect(new Set(ids.map(pageOfNode))).toEqual(new Set([pageId]));
  });

  it("depth 展开到叶子后节点数与 fixture 一致", async () => {
    const doc = await call("read_document", { scope: "page", pageId, depth: 8, limit: 1000 });
    expect((doc.nodes as Array<{ id: string }>).length).toBe(1000);
    expect(doc.truncated).toBe(true);
  });

  it("读单张卡片（子树）体积很小", async () => {
    const frameId = store.doc.nodes[pageId].children[0];
    const raw = await run("read_document", { scope: "subtree", subtreeId: frameId });
    const parsed = JSON.parse(raw) as { nodes: unknown[] };
    expect(parsed.nodes).toHaveLength(1 + LEAVES_PER_FRAME);
    expect(raw.length).toBeLessThanOrEqual(8 * 1024);
  });

  it("搜索 10 万节点受 limit 约束且不返回子树（含耗时保险丝）", async () => {
    const started = Date.now();
    const res = await call("search_nodes", { name: "Card", limit: 20 });
    const elapsed = Date.now() - started;

    const hits = res.hits as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(20);
    expect(res.hasMore).toBe(true);
    expect(hits.every((h) => h.subtree === undefined && h.children === undefined)).toBe(true);
    expect(hits.every((h) => h.rootKind === "page" && h.rootId === pageId)).toBe(true);
    // 只防 O(N²) 退化，不是性能目标
    // 只防 O(N²) 退化，不是性能目标；慢 CI 上给足余量
    expect(elapsed).toBeLessThan(5000);
  });

  it("搜索 → 只读子树闭环体积很小", async () => {
    const hit = ((await call("search_nodes", { name: "Card 0-7" })).hits as Array<{ id: string }>)[0];
    expect(hit).toBeTruthy();
    const raw = await run("read_document", { scope: "subtree", subtreeId: hit.id });
    expect(raw.length).toBeLessThanOrEqual(8 * 1024);
  });
});
