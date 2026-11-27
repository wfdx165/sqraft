import { describe, expect, it } from "vitest";
import { sortRecent } from "./recent-order";
import type { RecentEntry } from "../shared/ipc";

function entry(path: string, mtimeMs: number | null): RecentEntry {
  return { path, name: path, mtimeMs, thumbnail: null };
}

describe("最近文件的展示顺序", () => {
  it("按修改时间倒序，与传入顺序无关", () => {
    const list = [entry("old", 1000), entry("new", 5000), entry("mid", 3000)];
    expect(sortRecent(list).map((item) => item.path)).toEqual(["new", "mid", "old"]);
  });

  it("已移动 / 删除的文件排在最后", () => {
    const list = [entry("gone", null), entry("a", 1000), entry("b", 3000)];
    expect(sortRecent(list).map((item) => item.path)).toEqual(["b", "a", "gone"]);
  });

  it("修改时间相同保持传入顺序（稳定排序）", () => {
    const list = [entry("first", 2000), entry("second", 2000)];
    expect(sortRecent(list).map((item) => item.path)).toEqual(["first", "second"]);
  });

  it("不改动传入数组", () => {
    const list = [entry("a", 1000), entry("b", 2000)];
    sortRecent(list);
    expect(list.map((item) => item.path)).toEqual(["a", "b"]);
  });
});
