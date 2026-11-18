import { describe, expect, it } from "vitest";
import type { DocState } from "@sqraft/core";
import { collectLayerItems, collectPageItems, collectTokenItems, rankSources } from "./palette-sources";

function node(id: string, type: string, name: string, parentId: string | null, children: string[] = []) {
  return {
    id,
    type,
    name,
    parentId,
    children,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    clip: false,
  };
}

const doc = {
  rootIds: ["page-1", "master"],
  nodes: {
    "page-1": node("page-1", "page", "Home", null, ["frame", "anon"]),
    frame: node("frame", "frame", "Card", "page-1", ["title"]),
    title: node("title", "text", "Title", "frame"),
    anon: node("anon", "rect", "", "page-1"),
    master: node("master", "component", "Button", null, ["label"]),
    label: node("label", "text", "Button label", "master"),
  },
  tokens: {
    "color/action": { type: "color", value: "#3366ff" },
    "space/4": { type: "number", value: 4 },
  },
  version: 1,
  formatVersion: 9,
  strictTokens: false,
} as unknown as DocState;

describe("页面候选", () => {
  it("只收 page 根节点", () => {
    expect(collectPageItems(doc).map((item) => item.id)).toEqual(["page-1"]);
  });
});

describe("图层候选", () => {
  it("当前页模式只扫活动页子树，跳过匿名节点", () => {
    const items = collectLayerItems(doc, "page-1", "page");
    expect(items.map((item) => item.id).sort()).toEqual(["frame", "title"]);
    expect(items.find((item) => item.id === "title")?.hint).toBe("Card");
  });

  it("全文模式包含组件母版", () => {
    const ids = collectLayerItems(doc, "page-1", "document").map((item) => item.id);
    expect(ids).toContain("master");
    expect(ids).toContain("label");
    expect(ids).not.toContain("page-1");
    expect(ids).not.toContain("anon");
  });
});

describe("Token 候选", () => {
  it("路径为 label，值为 hint", () => {
    const items = collectTokenItems(doc);
    expect(items.find((item) => item.id === "color/action")?.hint).toBe("#3366ff");
    expect(items.find((item) => item.id === "space/4")?.hint).toBe("4");
  });
});

describe("打分与排序", () => {
  it("全等压过前缀，前缀压过子串；0 分被过滤", () => {
    const items = [
      { kind: "page" as const, id: "1", label: "卡片列表", hint: "" },
      { kind: "layer" as const, id: "2", label: "卡片", hint: "" },
      { kind: "token" as const, id: "3", label: "无关", hint: "" },
    ];
    const ranked = rankSources("卡片", items);
    expect(ranked.map((item) => item.id)).toEqual(["2", "1"]);
  });

  it("同分时按 kind 顺序：页面 → 图层 → Token → 文件", () => {
    const ranked = rankSources("x", [
      { kind: "file" as const, id: "f", label: "x", hint: "" },
      { kind: "token" as const, id: "t", label: "x", hint: "" },
      { kind: "page" as const, id: "p", label: "x", hint: "" },
      { kind: "layer" as const, id: "l", label: "x", hint: "" },
    ]);
    expect(ranked.map((item) => item.kind)).toEqual(["page", "layer", "token", "file"]);
  });

  it("limit 生效", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: "layer" as const,
      id: String(index),
      label: `Item ${index}`,
      hint: "",
    }));
    expect(rankSources("item", items, 3)).toHaveLength(3);
  });
});
