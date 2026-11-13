import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { CURRENT_FORMAT_VERSION, createDocWithPage, createEmptyDoc } from "@sqraft/core";
import { parseDoc, serializeDoc } from "./fileio";

describe(".sqraft 容器", () => {
  it("图片资源按 assets/ 写进 zip，并能原样读回", async () => {
    const state = createEmptyDoc();
    const image = new Uint8Array([1, 2, 3, 4]);
    const bytes = await serializeDoc(state, [{ name: "assets/abcd1234.png", bytes: image }]);

    const parsed = await parseDoc(bytes);
    expect(parsed.state.rootIds).toEqual(state.rootIds);
    expect(parsed.files["assets/abcd1234.png"]).toEqual(image);
  });

  it("打开 → 再保存 → 再打开：图片字节（零拷贝视图）与文档原样保留", async () => {
    const state = createDocWithPage("页面");
    const images = [
      { name: "assets/aaaa0000.png", bytes: new Uint8Array(5000).map((_, i) => i % 251) },
      { name: "assets/bbbb1111.jpg", bytes: new Uint8Array(3000).map((_, i) => (i * 7) % 253) },
    ];
    const first = await parseDoc(await serializeDoc(state, images));
    // 打开后的图片是原文件缓冲区的视图：直接拿它们再保存
    const again = Object.entries(first.files)
      .filter(([name]) => name.startsWith("assets/"))
      .map(([name, bytes]) => ({ name, bytes }));
    const second = await parseDoc(await serializeDoc(first.state, again));
    expect(second.state).toEqual(first.state);
    for (const image of images) expect(second.files[image.name]).toEqual(image.bytes);
  });

  it("没有资源时也能正常往返", async () => {
    const bytes = await serializeDoc(createEmptyDoc());
    const parsed = await parseDoc(bytes);
    expect(parsed.files["doc.json"]).toBeDefined();
    expect(Object.keys(parsed.files).filter((k) => k.startsWith("assets/"))).toEqual([]);
  });

  it("doc.json 超过 160KB 也能往返（fflate async 路径曾走 blob worker，打包 CSP 会挂死）", async () => {
    // 页名塞够长，把 doc.json 顶过 fflate 选择 worker 压缩的 160000 字节阈值
    const name = "大".repeat(90_000);
    const state = createDocWithPage(name);
    const bytes = await serializeDoc(state);
    expect(bytes.length).toBeGreaterThan(0);
    const parsed = await parseDoc(bytes);
    const page = Object.values(parsed.state.nodes).find((node) => node.type === "page");
    expect(page?.name).toBe(name);
  });

  it("缺 doc.json 时给出可读错误", async () => {
    await expect(parseDoc(new Uint8Array([1, 2, 3]))).rejects.toBeTruthy();
  });

  it("manifest 记录真实应用版本", async () => {
    const bytes = await serializeDoc(createEmptyDoc(), [], "0.1.0");
    const manifest = JSON.parse(strFromU8(unzipSync(bytes)["manifest.json"])) as { version: string };
    expect(manifest.version).toBe("0.1.0");
  });

  it("格式版本比当前新时明确拒绝（旧版不能猜着读新稿）", async () => {
    const state = createEmptyDoc();
    state.formatVersion = CURRENT_FORMAT_VERSION + 1;
    const bytes = await serializeDoc(state);
    await expect(parseDoc(bytes)).rejects.toThrow(/请升级 Sqraft/);
  });
});
