import { describe, expect, it } from "vitest";
import { createDocStaging, DOC_STAGING_TTL_MS } from "./doc-staging";

describe("打开文档的一次性取件凭证", () => {
  it("凭证只能用一次", () => {
    const staging = createDocStaging();
    const token = staging.stage({ path: "/a.sqraft", size: 10 });
    expect(staging.take(token)).toEqual({ path: "/a.sqraft", size: 10 });
    expect(staging.take(token)).toBeNull();
  });

  it("凭证是 128 位随机数，每次不同；未登记的凭证取不到", () => {
    const staging = createDocStaging();
    const a = staging.stage({ path: "/a", size: 1 });
    const b = staging.stage({ path: "/a", size: 1 });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(staging.take("../../etc/passwd")).toBeNull();
  });

  it("过期后作废", () => {
    let now = 1000;
    const staging = createDocStaging(() => now);
    const token = staging.stage({ path: "/a", size: 1 });
    now += DOC_STAGING_TTL_MS + 1;
    expect(staging.take(token)).toBeNull();
  });
});
