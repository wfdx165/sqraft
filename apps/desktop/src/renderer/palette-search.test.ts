import { describe, expect, it } from "vitest";
import { COMMANDS } from "../shared/commands";
import { zhCN } from "../shared/i18n/zh-CN";
import { isAvailable, scoreLabel, searchCommands, type PaletteContext } from "./palette-search";

const open: PaletteContext = { docOpen: true, selection: true, presenter: false };
const anything = () => true;
/** 测试默认按 key 当文案（英文场景）；中文场景单独传字典解析器。 */
const byKey = (command: { labelKey: keyof typeof zhCN }) => command.labelKey;

describe("匹配打分", () => {
  it("全等 > 前缀 > 子串 > 子序列", () => {
    expect(scoreLabel("新建", "新建")).toBe(1000);
    expect(scoreLabel("新建", "新建文档")).toBe(800);
    expect(scoreLabel("文档", "新建文档")).toBeGreaterThan(500);
    expect(scoreLabel("新档", "新建文档")).toBeGreaterThan(0);
    expect(scoreLabel("新档", "新建文档")).toBeLessThan(600);
  });

  it("大小写不敏感；不命中返回 0", () => {
    expect(scoreLabel("save", "Save")).toBe(1000);
    expect(scoreLabel("zzz", "保存")).toBe(0);
  });
});

describe("可用性", () => {
  it("文档 / 选区 / 演示模式", () => {
    const save = COMMANDS.find((command) => command.id === "file.save")!;
    expect(isAvailable(save, { docOpen: false, selection: false, presenter: false })).toBe(false);
    const copy = COMMANDS.find((command) => command.id === "edit.copy")!;
    expect(isAvailable(copy, { docOpen: true, selection: false, presenter: false })).toBe(false);
    expect(isAvailable(copy, open)).toBe(true);
    expect(isAvailable(save, { ...open, presenter: true })).toBe(false);
  });

  it("面板不列出自己", () => {
    const palette = COMMANDS.find((command) => command.id === "palette.open")!;
    expect(isAvailable(palette, open)).toBe(false);
  });
});

describe("搜索", () => {
  it("空查询：最近命令在前，其余按分组排序", () => {
    const result = searchCommands("", ["file.save", "edit.copy"], anything, byKey);
    expect(result.recent.map((command) => command.id)).toEqual(["file.save", "edit.copy"]);
    expect(result.commands[0]?.group).toBe("file");
    expect(result.commands.some((command) => command.id === "file.save")).toBe(false);
  });

  it("最近命令里的未知 / 不可用项被过滤", () => {
    const result = searchCommands("", ["bogus" as never, "file.save"], (command) => command.id !== "file.save", byKey);
    expect(result.recent).toEqual([]);
  });

  it("有查询：命中排序、大小写不敏感、limit 生效", () => {
    const result = searchCommands("save", [], anything, byKey, 5);
    expect(result.commands.length).toBeLessThanOrEqual(5);
    expect(result.commands[0]?.id).toBe("file.save");
    expect(searchCommands("SAVE", [], anything, byKey).commands[0]?.id).toBe("file.save");
  });

  it("按本地化标签搜索：中文查询能命中命令", () => {
    // 用真实中文文案解析器——若按 labelKey（ASCII）打分，这里会得到空数组
    const zh = (command: (typeof COMMANDS)[number]) => zhCN[command.labelKey];
    const result = searchCommands("保存", [], anything, zh);
    expect(result.commands.some((command) => command.id === "file.save")).toBe(true);
    expect(searchCommands("新建", [], anything, zh).commands.length).toBeGreaterThan(0);
  });

  it("不命中返回空", () => {
    expect(searchCommands("zzzz", [], anything, byKey).commands).toEqual([]);
  });
});
