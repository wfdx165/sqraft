import { describe, expect, it } from "vitest";
import { accentOf, LIBRARY_ACCENT, SELECT_ACCENT } from "./selection-overlay";

describe("选中框配色", () => {
  it("实例与主组件用库对象色", () => {
    expect(accentOf({ type: "instance" })).toBe(LIBRARY_ACCENT);
    expect(accentOf({ type: "component" })).toBe(LIBRARY_ACCENT);
  });

  it("其它图层保持 indigo", () => {
    for (const type of ["frame", "rect", "text", "group", "page", "slot"] as const) {
      expect(accentOf({ type })).toBe(SELECT_ACCENT);
    }
    expect(accentOf(null)).toBe(SELECT_ACCENT);
  });

  it("库对象色与普通图层色不同（悬停/选中不能靠线宽区分）", () => {
    expect(LIBRARY_ACCENT).not.toBe(SELECT_ACCENT);
  });
});
