import { describe, expect, it } from "vitest";
import { COMMAND_GROUP_ORDER, COMMAND_IDS, COMMANDS, commandOf, isCommandId, type CommandId } from "./commands";

describe("命令注册表", () => {
  it("id 唯一且与 COMMAND_IDS 完全一致", () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...COMMAND_IDS].sort());
  });

  it("默认键位不重复", () => {
    const defaults = COMMANDS.flatMap((command) => (command.default ? [command.default] : []));
    expect(new Set(defaults).size).toBe(defaults.length);
  });

  it("每个分组都在排序表里", () => {
    for (const command of COMMANDS) expect(COMMAND_GROUP_ORDER).toContain(command.group);
  });

  it("主进程专属命令没有快捷键、且 owner = main", () => {
    for (const command of COMMANDS.filter((item) => item.id.startsWith("app."))) {
      expect(command.owner).toBe("main");
      expect(command.default).toBeUndefined();
    }
  });

  it("commandOf 对未知 id 抛错", () => {
    expect(() => commandOf("nope" as CommandId)).toThrow(/unknown command/);
  });

  it("isCommandId 只认白名单", () => {
    expect(isCommandId("file.save")).toBe(true);
    expect(isCommandId("app.mcpSetup")).toBe(true);
    expect(isCommandId("file.saveAs")).toBe(true);
    expect(isCommandId("nope")).toBe(false);
    expect(isCommandId(1)).toBe(false);
  });
});
