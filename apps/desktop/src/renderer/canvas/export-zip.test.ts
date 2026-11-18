import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildExportZip } from "./export-zip";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);

describe("多倍率导出包", () => {
  it("条目平铺在根目录，PNG 字节原样保留，SVG 可回读", () => {
    const zip = buildExportZip([
      { name: "稿-矩形@1.png", bytes: PNG, format: "png" },
      { name: "稿-矩形@2.png", bytes: PNG, format: "png" },
      { name: "稿-矩形.svg", bytes: new TextEncoder().encode("<svg/>"), format: "svg" },
    ]);
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(["稿-矩形.svg", "稿-矩形@1.png", "稿-矩形@2.png"]);
    expect([...entries["稿-矩形@1.png"]!]).toEqual([...PNG]);
    expect([...entries["稿-矩形@2.png"]!]).toEqual([...PNG]);
    expect(strFromU8(entries["稿-矩形.svg"]!)).toBe("<svg/>");
  });

  it("没有条目时也能产出可解析的空包（渲染层已拦，这里只保证不抛）", () => {
    expect(unzipSync(buildExportZip([]))).toEqual({});
  });
});
