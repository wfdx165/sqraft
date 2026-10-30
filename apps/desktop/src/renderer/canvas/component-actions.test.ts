import { describe, expect, it } from "vitest";
import { clampInstanceCenter } from "./component-actions";

describe("插入实例的落点夹紧", () => {
  it("视口中心在页面内 → 原样使用", () => {
    expect(clampInstanceCenter(300, 0, 400, 100)).toBe(300);
  });

  it("视口中心在页面左侧/上方 → 夹到页面内边距", () => {
    expect(clampInstanceCenter(-200, 0, 400, 100)).toBe(50);
    expect(clampInstanceCenter(-50, 100, 200, 80)).toBe(140);
  });

  it("视口中心在页面右侧/下方 → 夹到页面内边距", () => {
    expect(clampInstanceCenter(900, 0, 400, 100)).toBe(350);
  });

  it("母版比页面还宽 → 退回页面中心，不跑到页面外", () => {
    expect(clampInstanceCenter(0, 0, 100, 400)).toBe(50);
    expect(clampInstanceCenter(999, 0, 100, 400)).toBe(50);
  });
});
