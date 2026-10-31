import { describe, expect, it, vi } from "vitest";

// linked-images 在模块顶层读 hooks（无需 DOM）；抓取入口走 window.sqraft
const fetchImage = vi.fn(async () => ({ ok: false as const, reason: "测试不走网络" }));
vi.stubGlobal("window", { sqraft: { app: { fetchImage } } });

const { linkedImage, linkedImageStatus, resetLinkedImages } = await import("./linked-images");

describe("链接图的状态机", () => {
  it("没加载过的 URL 是 idle，reset 之后还是 idle", () => {
    expect(linkedImageStatus("https://example.com/a.png").status).toBe("idle");
    resetLinkedImages();
    expect(linkedImageStatus("https://example.com/a.png").status).toBe("idle");
  });

  it("抓取失败会记成 failed 并带原因，不会一直停在 loading", async () => {
    linkedImage("https://example.com/broken.png");
    await vi.waitFor(() => expect(linkedImageStatus("https://example.com/broken.png").status).toBe("failed"));
    expect(linkedImageStatus("https://example.com/broken.png").error).toContain("测试不走网络");
  });

  it("reset 之后重新发起会重新走一次加载", async () => {
    linkedImage("https://example.com/c.png");
    await vi.waitFor(() => expect(linkedImageStatus("https://example.com/c.png").status).toBe("failed"));
    resetLinkedImages();
    expect(linkedImageStatus("https://example.com/c.png").status).toBe("idle");
    const before = fetchImage.mock.calls.length;
    linkedImage("https://example.com/c.png");
    await vi.waitFor(() => expect(fetchImage.mock.calls.length).toBeGreaterThan(before));
  });
});
