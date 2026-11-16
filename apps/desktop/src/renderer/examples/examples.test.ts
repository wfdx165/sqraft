import { describe, expect, it } from "vitest";
import { diagnose } from "@sqraft/core";
import { buildCardGridExample } from "./cards";
import { buildLoginExample } from "./login";
import { buildUmbraExample } from "./umbra";

const builders = [
  ["login", buildLoginExample, 40],
  ["cards", buildCardGridExample, 40],
  ["umbra", buildUmbraExample, 60],
] as const;

describe.each(builders)("%s 示例", (_name, build, maxNodes) => {
  const { state } = build();

  it("只有一个页面，父子关系一致", () => {
    expect(state.rootIds).toHaveLength(1);
    const page = state.nodes[state.rootIds[0]!]!;
    expect(page.type).toBe("page");
    for (const node of Object.values(state.nodes)) {
      if (node.parentId === null) {
        expect(state.rootIds).toContain(node.id);
        continue;
      }
      const parent = state.nodes[node.parentId];
      expect(parent).toBeTruthy();
      expect(parent!.children).toContain(node.id);
    }
    expect(Object.keys(state.nodes)).toHaveLength(
      Object.values(state.nodes).reduce((sum, node) => sum + node.children.length, 0) + 1,
    );
  });

  it("id 唯一、无 Token、严格模式关闭", () => {
    const ids = Object.values(state.nodes).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(state.tokens).toEqual({});
    expect(state.strictTokens).toBe(false);
  });

  it("没有诊断（零尺寸 / 无填充文本 / 越界）", () => {
    expect(diagnose(state, state.rootIds).diagnostics).toEqual([]);
  });

  it("节点数量在预期区间", () => {
    expect(Object.keys(state.nodes).length).toBeGreaterThan(8);
    expect(Object.keys(state.nodes).length).toBeLessThan(maxNodes);
  });
});
