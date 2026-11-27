import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildInstallScript, resolveInstallSupport, type ScriptOptions } from "./install";

const writable = async () => true;

function scriptOptions(patch: Partial<ScriptOptions> = {}): ScriptOptions {
  return {
    appPath: "/Applications/Sqraft.app",
    backupPath: "/Applications/Sqraft.app.backup",
    zipPath: "/tmp/update.zip",
    scriptPath: "/tmp/install.sh",
    logPath: "/tmp/install.log",
    markerPath: "/tmp/launched",
    failedPath: "/tmp/install-failed.json",
    stagingPath: "/tmp/staging",
    pid: 123,
    version: "0.1.3",
    appName: "Sqraft.app",
    ...patch,
  };
}

describe("更新支持判定", () => {
  it("开发态一律不检查", async () => {
    const support = await resolveInstallSupport({
      packaged: false,
      platform: "darwin",
      arch: "arm64",
      executable: "/Applications/Sqraft.app/Contents/MacOS/Sqraft",
    });
    expect(support.mode).toBe("none");
  });

  it("打包后的 Windows 只提示、不安装", async () => {
    const support = await resolveInstallSupport({
      packaged: true,
      platform: "win32",
      arch: "x64",
      executable: "C:\\Users\\me\\AppData\\Local\\Programs\\Sqraft\\Sqraft.exe",
      isWritable: writable,
    });
    expect(support.mode).toBe("notify");
    expect(support.reason).toBe("");
    expect(support.appPath).toBeNull();
  });

  it("macOS arm64 且可写 → 就地安装", async () => {
    const support = await resolveInstallSupport({
      packaged: true,
      platform: "darwin",
      arch: "arm64",
      executable: "/Applications/Sqraft.app/Contents/MacOS/Sqraft",
      isWritable: writable,
    });
    expect(support.mode).toBe("install");
    expect(support.appPath).toBe("/Applications/Sqraft.app");
  });

  it("macOS x64 且可写 → 同样就地安装（ADR-0046）", async () => {
    const support = await resolveInstallSupport({
      packaged: true,
      platform: "darwin",
      arch: "x64",
      executable: "/Applications/Sqraft.app/Contents/MacOS/Sqraft",
      isWritable: writable,
    });
    expect(support.mode).toBe("install");
    expect(support.appPath).toBe("/Applications/Sqraft.app");
  });

  it("macOS 其它架构（如 ia32）不检查", async () => {
    const support = await resolveInstallSupport({
      packaged: true,
      platform: "darwin",
      arch: "ia32",
      executable: "/Applications/Sqraft.app/Contents/MacOS/Sqraft",
      isWritable: writable,
    });
    expect(support.mode).toBe("none");
  });

  it("Linux 等平台不检查", async () => {
    const support = await resolveInstallSupport({
      packaged: true,
      platform: "linux",
      arch: "x64",
      executable: "/opt/sqraft/sqraft",
      isWritable: writable,
    });
    expect(support.mode).toBe("none");
  });
});

describe("安装脚本", () => {
  it("替换前用 lipo 校验架构，期望值来自当前进程", () => {
    const script = buildInstallScript(scriptOptions({ expectedArch: "x64" }));
    expect(script).toContain("EXPECTED_ARCH='x64'");
    expect(script).toContain("/usr/bin/lipo -archs");
    // 校验必须发生在移走旧版本之前
    expect(script.indexOf("lipo -archs")).toBeLessThan(script.indexOf('mv "$APP" "$BACKUP"'));
  });

  it("arm64 期望值同样写进脚本", () => {
    const script = buildInstallScript(scriptOptions({ expectedArch: "arm64" }));
    expect(script).toContain("EXPECTED_ARCH='arm64'");
    expect(script).toContain('*" arm64 "*) GOT_ARCH=arm64');
  });

  it("生成的脚本通过 /bin/sh 语法检查", () => {
    const script = buildInstallScript(scriptOptions({ expectedArch: "x64" }));
    const result = spawnSync("/bin/sh", ["-n"], { input: script, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
