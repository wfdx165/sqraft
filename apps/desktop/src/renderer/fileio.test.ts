import { describe, expect, it } from "vitest";
import { createEmptyDoc } from "@sqraft/core";
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

  it("没有资源时也能正常往返", async () => {
    const bytes = await serializeDoc(createEmptyDoc());
    const parsed = await parseDoc(bytes);
    expect(parsed.files["doc.json"]).toBeDefined();
    expect(Object.keys(parsed.files).filter((k) => k.startsWith("assets/"))).toEqual([]);
  });

  it("缺 doc.json 时给出可读错误", async () => {
    await expect(parseDoc(new Uint8Array([1, 2, 3]))).rejects.toBeTruthy();
  });
});
