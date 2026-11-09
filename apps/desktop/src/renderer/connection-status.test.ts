import { describe, expect, it } from "vitest";
import { CONNECTION_VISIBLE_LIMIT, visibleClients } from "./connection-status";

describe("连接详情列表的裁剪", () => {
  it("不超过 5 条时全部显示，没有剩余计数", () => {
    const list = ["a", "b", "c", "d", "e"];
    expect(visibleClients(list)).toEqual({ rows: list, more: 0 });
    expect(CONNECTION_VISIBLE_LIMIT).toBe(5);
  });

  it("超过 5 条只留前 5 条，其余只报数量", () => {
    const list = Array.from({ length: 10 }, (_, index) => `c${index}`);
    const { rows, more } = visibleClients(list);
    expect(rows).toEqual(list.slice(0, 5));
    expect(more).toBe(5);
  });

  it("空列表与自定义上限", () => {
    expect(visibleClients([])).toEqual({ rows: [], more: 0 });
    expect(visibleClients(["a", "b", "c"], 1)).toEqual({ rows: ["a"], more: 2 });
    expect(visibleClients(["a"], 0)).toEqual({ rows: [], more: 1 });
  });
});
