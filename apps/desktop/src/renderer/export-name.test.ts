import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, firstPageId } from "@sqraft/core";
import { exportFileName, exportMatrixObjectName, exportObjectName } from "./export-name";

describe("导出 PNG 的文件名", () => {
  it("文档名 + 对象名 + 倍率", () => {
    expect(exportFileName("未命名", "矩形", "png")).toBe("未命名-矩形@1.png");
    expect(exportFileName("电商改版.sqraft", "首页", "png", 2)).toBe("电商改版-首页@2.png");
  });

  it("对象名为空时只用文档名，倍率一样要带", () => {
    expect(exportFileName("未命名", "", "png")).toBe("未命名@1.png");
    expect(exportFileName("未命名", "   ", "png", 4)).toBe("未命名@4.png");
  });

  it("非法字符换成连字符，压缩空白并截断", () => {
    expect(exportFileName("稿", "按钮/主:态*问?", "png", 2)).toBe("稿-按钮-主-态-问-@2.png");
    expect(exportFileName("稿", "a   b", "png")).toBe("稿-a b@1.png");
    expect(exportFileName("稿", "x".repeat(200), "png").length).toBeLessThanOrEqual(
      "稿-".length + 80 + "@1.png".length,
    );
  });

  it("文档名缺失时退回「未命名」", () => {
    expect(exportFileName("", "矩形", "png")).toBe("未命名-矩形@1.png");
  });

  it("SVG 不带倍率后缀", () => {
    expect(exportFileName("未命名", "矩形", "svg")).toBe("未命名-矩形.svg");
    expect(exportFileName("未命名", "矩形", "svg", 2)).toBe("未命名-矩形.svg");
    expect(exportFileName("未命名", "", "svg")).toBe("未命名.svg");
  });

  it("ZIP 导出包也不带倍率后缀", () => {
    expect(exportFileName("未命名", "矩形", "zip")).toBe("未命名-矩形.zip");
    expect(exportFileName("电商改版.sqraft", "", "zip")).toBe("电商改版.zip");
  });
});

describe("多倍率导出的对象名", () => {
  it("页面名在前，单选中对象时再接节点名；整页不重复", () => {
    const doc = createDocWithPage("首页");
    const pageId = firstPageId(doc)!;
    const a = createNode("rect", { parentId: pageId, name: "按钮" });
    const b = createNode("rect", { parentId: pageId, name: "卡片" });
    doc.nodes[a.id] = a;
    doc.nodes[b.id] = b;

    expect(exportMatrixObjectName(doc, { pageId })).toBe("首页");
    expect(exportMatrixObjectName(doc, { pageId, nodeIds: [a.id] })).toBe("首页-按钮");
    expect(exportMatrixObjectName(doc, { pageId, nodeIds: [a.id, b.id] })).toBe("首页");
    expect(exportMatrixObjectName(doc, { pageId: null, nodeIds: [a.id] })).toBe("按钮");
  });

  it("页面名与对象名经 exportFileName 后得到完整前缀", () => {
    expect(exportFileName("未命名", "首页-按钮", "zip")).toBe("未命名-首页-按钮.zip");
    expect(exportFileName("未命名", "首页-按钮", "png", 2)).toBe("未命名-首页-按钮@2.png");
  });
});

describe("导出对象名", () => {
  it("整页导出取页面名，单选取节点名，多选不带", () => {
    const doc = createDocWithPage("首页");
    const pageId = firstPageId(doc)!;
    const a = createNode("rect", { parentId: pageId, name: "按钮" });
    const b = createNode("rect", { parentId: pageId, name: "卡片" });
    doc.nodes[a.id] = a;
    doc.nodes[b.id] = b;

    expect(exportObjectName(doc, { pageId, nodeIds: undefined })).toBe("首页");
    expect(exportObjectName(doc, { pageId, nodeIds: [a.id] })).toBe("按钮");
    expect(exportObjectName(doc, { pageId, nodeIds: [a.id, b.id] })).toBe("");
    expect(exportObjectName(doc, { pageId: null })).toBe("");
  });
});
