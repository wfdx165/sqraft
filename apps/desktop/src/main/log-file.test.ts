import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOG_FILE_NAME, initLogFile, logFileDir, logFilePath, resetLogFile, writeLogLine } from "./log-file";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sqraft-log-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  resetLogFile();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("日志落盘", () => {
  it("追加写：一行一条，目录不存在时自动创建", () => {
    const dir = join(tempDir(), "logs");
    initLogFile({ dir });
    writeLogLine("[app] a");
    writeLogLine("[app] b");

    expect(readFileSync(join(dir, LOG_FILE_NAME), "utf8")).toBe("[app] a\n[app] b\n");
    expect(logFileDir()).toBe(dir);
    expect(logFilePath()).toBe(join(dir, LOG_FILE_NAME));
  });

  it("写满后轮转：当前文件清空，旧内容进 .1", () => {
    const dir = tempDir();
    initLogFile({ dir, maxBytes: 50 });
    writeLogLine("A".repeat(40));
    writeLogLine("B".repeat(40));

    expect(readFileSync(join(dir, LOG_FILE_NAME), "utf8")).toBe(`${"B".repeat(40)}\n`);
    expect(readFileSync(join(dir, `${LOG_FILE_NAME}.1`), "utf8")).toBe(`${"A".repeat(40)}\n`);
  });

  it("归档按序号顶替，超出保留数量的旧文件在启动时清掉", () => {
    const dir = tempDir();
    for (let index = 1; index <= 5; index += 1) {
      writeFileSync(join(dir, `${LOG_FILE_NAME}.${index}`), `old-${index}`);
    }

    initLogFile({ dir, maxFiles: 3 });
    expect(readdirSync(dir).sort()).toEqual([`${LOG_FILE_NAME}.1`, `${LOG_FILE_NAME}.2`]);
  });

  it("连续轮转后只保留 maxFiles 个文件（含当前文件）", () => {
    const dir = tempDir();
    initLogFile({ dir, maxBytes: 20, maxFiles: 3 });
    for (const label of ["A", "B", "C", "D", "E"]) writeLogLine(`${label}${"x".repeat(19)}`);

    expect(readdirSync(dir).sort()).toEqual([LOG_FILE_NAME, `${LOG_FILE_NAME}.1`, `${LOG_FILE_NAME}.2`]);
    // 最新的一行在当前文件里，最旧的两代已经被挤掉
    expect(readFileSync(join(dir, LOG_FILE_NAME), "utf8")).toContain("E");
    expect(readFileSync(join(dir, `${LOG_FILE_NAME}.1`), "utf8")).toContain("D");
  });

  it("目录不可用时静默降级，不影响调用方", () => {
    const blocker = join(tempDir(), "not-a-dir");
    writeFileSync(blocker, "occupied");

    expect(() => initLogFile({ dir: blocker })).not.toThrow();
    expect(() => writeLogLine("[app] still ok")).not.toThrow();
    // 失败时菜单/排障提示不该指向一个不存在的目录
    expect(logFileDir()).toBeNull();
    expect(logFilePath()).toBeNull();
  });

  it("未初始化时写入直接丢弃", () => {
    resetLogFile();
    expect(() => writeLogLine("[app] nowhere")).not.toThrow();
    expect(logFilePath()).toBeNull();
  });

  it("重复初始化会换目录并重新计算体积", () => {
    const first = tempDir();
    const second = join(tempDir(), "nested");
    initLogFile({ dir: first });
    writeLogLine("first");
    initLogFile({ dir: second });
    writeLogLine("second");

    expect(readFileSync(join(second, LOG_FILE_NAME), "utf8")).toBe("second\n");
  });
});
