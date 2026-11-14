import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { readZip } from "./zip-read";

describe("快速 zip 读取（打开 .sqraft 用）", () => {
  it("存储条目是原缓冲区的零拷贝视图，压缩条目原生解压，内容与写入一致", async () => {
    const image = new Uint8Array(4096).map((_, i) => (i * 31) % 251);
    const json = strToU8(JSON.stringify({ hello: "世界", list: Array.from({ length: 2000 }, (_, i) => i) }));
    const bytes = zipSync({
      "doc.json": json,
      "manifest.json": [strToU8("{}"), { level: 0 }],
      "assets/abc.png": [image, { level: 0 }],
    });
    const files = (await readZip(bytes))!;
    expect(files).not.toBeNull();
    expect(Object.keys(files).sort()).toEqual(["assets/abc.png", "doc.json", "manifest.json"]);
    expect(files["doc.json"]).toEqual(json);
    expect(files["assets/abc.png"]).toEqual(image);
    // 零拷贝：视图共享原文件的缓冲区
    expect(files["assets/abc.png"].buffer).toBe(bytes.buffer);
  });

  it("空条目与中文文件名也能读", async () => {
    const bytes = zipSync({ "ops.ndjson": new Uint8Array(0), "assets/图片.png": [new Uint8Array([1, 2, 3]), { level: 0 }] });
    const files = (await readZip(bytes))!;
    expect(files["ops.ndjson"]).toHaveLength(0);
    expect(Array.from(files["assets/图片.png"])).toEqual([1, 2, 3]);
  });

  it("不是 zip 或结构损坏时返回 null（调用方退回 fflate）", async () => {
    expect(await readZip(new Uint8Array([1, 2, 3]))).toBeNull();
    const bytes = zipSync({ "doc.json": strToU8("{}") });
    const broken = bytes.slice();
    // 破坏中央目录签名
    const view = new DataView(broken.buffer);
    for (let i = broken.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i, 0, true);
        break;
      }
    }
    expect(await readZip(broken)).toBeNull();
  });
});
