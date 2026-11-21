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

describe("日食示例（UMBRA）", () => {
  const { state } = buildUmbraExample();
  const nodes = Object.values(state.nodes);

  it("背景与光晕用原生渐变，不再靠模糊近似", () => {
    const page = state.nodes[state.rootIds[0]!]!;
    expect(page.style.fill).toMatchObject({ type: "linear" });
    const radial = nodes.filter((node) => node.style.fill && "type" in node.style.fill && node.style.fill.type === "radial");
    expect(radial.length).toBeGreaterThanOrEqual(3);
    expect(nodes.some((node) => node.style.effects?.some((effect) => effect.type === "layer-blur"))).toBe(false);
  });

  it("两条山脊是可编辑路径（单轮廓 + 渐变填充）", () => {
    const ridges = nodes.filter((node) => node.name.startsWith("Ridge"));
    expect(ridges).toHaveLength(2);
    for (const ridge of ridges) {
      expect(ridge.type).toBe("path");
      expect(ridge.vector?.anchors.length).toBeGreaterThan(5);
      expect(ridge.vector?.closed).toBe(true);
      expect(ridge.style.fill).toMatchObject({ type: "linear" });
    }
  });

  it("主按钮是渐变底 + 落影", () => {
    const button = nodes.find((node) => node.name === "Reserve button")!;
    expect(button.style.fill).toMatchObject({ type: "linear" });
    expect(button.style.effects?.[0]).toMatchObject({ type: "drop-shadow", y: 8 });
  });
});
