import { describe, expect, it } from "vitest";
import { menuStateOf } from "./menu-state";

describe("菜单状态映射", () => {
  it("presenting 归一成布尔：null = 不在演示，对象 = 在演示", () => {
    expect(menuStateOf(true, null)).toEqual({ docOpen: true, presenting: false });
    expect(menuStateOf(true, { pageId: "page-1", scroll: 0, stack: [] })).toEqual({
      docOpen: true,
      presenting: true,
    });
  });

  it("docOpen 也归一成布尔，主进程只接受布尔值", () => {
    expect(menuStateOf(false, null)).toEqual({ docOpen: false, presenting: false });
    expect(typeof menuStateOf(true, null).docOpen).toBe("boolean");
    expect(typeof menuStateOf(true, null).presenting).toBe("boolean");
  });
});
