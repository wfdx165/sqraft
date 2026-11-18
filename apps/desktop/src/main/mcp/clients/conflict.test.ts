import { describe, expect, it } from "vitest";
import { decideConflict, isSqraftLoopbackUrl } from "./conflict";

const desired = "http://127.0.0.1:7331/mcp";

describe("冲突判定", () => {
  it("没有条目 → 直接写", () => {
    expect(decideConflict({ exists: false, existingUrl: null, desiredUrl: desired, owned: false })).toBe("update");
  });

  it("地址一致 → 跳过写", () => {
    expect(
      decideConflict({ exists: true, existingUrl: desired, desiredUrl: desired, owned: false }),
    ).toBe("skip-same");
  });

  it("清单内条目地址旧了 → 更新", () => {
    expect(
      decideConflict({
        exists: true,
        existingUrl: "http://127.0.0.1:7330/mcp",
        desiredUrl: desired,
        owned: true,
      }),
    ).toBe("update");
  });

  it("清单外但指向本机 Sqraft → 认领并覆盖", () => {
    expect(
      decideConflict({
        exists: true,
        existingUrl: "http://127.0.0.1:7330/mcp",
        desiredUrl: desired,
        owned: false,
      }),
    ).toBe("adopt");
  });

  it("指向别处或没有 url → 冲突，不动", () => {
    expect(
      decideConflict({
        exists: true,
        existingUrl: "https://example.com/mcp",
        desiredUrl: desired,
        owned: false,
      }),
    ).toBe("conflict");
    expect(
      decideConflict({ exists: true, existingUrl: null, desiredUrl: desired, owned: false }),
    ).toBe("conflict");
  });

  it("只认 http://127.0.0.1:<port>/mcp", () => {
    expect(isSqraftLoopbackUrl("http://127.0.0.1:7331/mcp")).toBe(true);
    expect(isSqraftLoopbackUrl("http://127.0.0.1:7331/mcp/")).toBe(false);
    expect(isSqraftLoopbackUrl("http://localhost:7331/mcp")).toBe(false);
    expect(isSqraftLoopbackUrl("https://127.0.0.1:7331/mcp")).toBe(false);
    expect(isSqraftLoopbackUrl("not a url")).toBe(false);
  });

  it("拒绝带凭据 / 查询 / 哈希 / 越界端口的伪端点", () => {
    expect(isSqraftLoopbackUrl("http://u@127.0.0.1:7331/mcp")).toBe(false);
    expect(isSqraftLoopbackUrl("http://127.0.0.1:7331/mcp?x=1")).toBe(false);
    expect(isSqraftLoopbackUrl("http://127.0.0.1:7331/mcp#x")).toBe(false);
    expect(isSqraftLoopbackUrl("http://127.0.0.1:22/mcp")).toBe(false);
    expect(isSqraftLoopbackUrl("http://127.0.0.1/mcp")).toBe(false);
  });
});
