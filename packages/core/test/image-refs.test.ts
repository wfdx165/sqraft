import { describe, expect, it } from "vitest";
import { createNode, imageCropOf, isLinkedImage } from "../src/model";

/**
 * 链接（远程）图在首次抓取前 `naturalWidth / naturalHeight` 为 0：
 * 裁切必须用解码出来的真实尺寸当整图范围，否则会被夹成 1×1。
 */
describe("链接图片的裁切范围", () => {
  it("尺寸未知 + 已解码：整图范围取解码尺寸", () => {
    const node = createNode("image", {
      image: { sourceUrl: "https://a/b.png", naturalWidth: 0, naturalHeight: 0 },
    });
    expect(imageCropOf(node, { width: 800, height: 600 })).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("尺寸未知且没有解码结果：退化成 1×1（此时渲染画占位，不会走到绘制）", () => {
    const node = createNode("image", {
      image: { sourceUrl: "https://a/b.png", naturalWidth: 0, naturalHeight: 0 },
    });
    expect(imageCropOf(node)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("越界裁切被夹回解码尺寸", () => {
    const node = createNode("image", {
      image: {
        sourceUrl: "https://a/b.png",
        naturalWidth: 0,
        naturalHeight: 0,
        crop: { x: 0, y: 0, width: 5000, height: 5000 },
      },
    });
    expect(imageCropOf(node, { width: 800, height: 600 })).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("嵌入图的裁切仍然只看文档里的原图尺寸", () => {
    const node = createNode("image", {
      image: { assetId: "a1", naturalWidth: 320, naturalHeight: 200 },
    });
    expect(imageCropOf(node, { width: 800, height: 600 })).toEqual({ x: 0, y: 0, width: 320, height: 200 });
  });

  it("isLinkedImage 只认 sourceUrl", () => {
    expect(isLinkedImage({ sourceUrl: "https://a/b.png", naturalWidth: 0, naturalHeight: 0 })).toBe(true);
    expect(isLinkedImage({ assetId: "a1", naturalWidth: 1, naturalHeight: 1 })).toBe(false);
    expect(isLinkedImage(undefined)).toBe(false);
  });
});
