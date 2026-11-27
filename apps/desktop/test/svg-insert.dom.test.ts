// @vitest-environment jsdom
/**
 * `insertSvgFrame` 的 store 参数：MCP 调用会传入发起调用时的标签 store，
 * 中途切标签也不能把 frame 写进活动标签（ADR-0041）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DocStore, createDocWithPage, firstPageId } from "@sqraft/core";
import { insertSvgFrame } from "../src/renderer/canvas/svg-insert";

beforeAll(() => {
  // 颜色归一化会探测 2D canvas：jsdom 没实现，固定返回 null 走字符串兜底
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { value: () => null, configurable: true });
});

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#3366ff"/></svg>`;

describe("SVG 导入的写入目标", () => {
  it("写进传入的 store，不碰别人的文档", async () => {
    const target = new DocStore(createDocWithPage());
    const other = new DocStore(createDocWithPage());
    const pageId = firstPageId(target.doc)!;
    const otherBefore = Object.keys(other.doc.nodes).length;

    const outcome = await insertSvgFrame({ text: SVG, name: "imported.svg", pageId }, target);
    expect(outcome.status).toBe("ok");

    const page = target.doc.nodes[pageId];
    expect(page.children).toHaveLength(1);
    const frame = target.doc.nodes[page.children[0]!];
    expect(frame.type).toBe("frame");
    // 另一个文档完全没被写：节点数保持原样
    expect(Object.keys(other.doc.nodes)).toHaveLength(otherBefore);
  });
});
