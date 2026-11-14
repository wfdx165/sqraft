import { describe, expect, it } from "vitest";
import { resolveInstallSupport } from "./install";

const writable = async () => true;

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

  it("macOS Intel 不支持（本版只出 arm64）", async () => {
    const support = await resolveInstallSupport({
      packaged: true,
      platform: "darwin",
      arch: "x64",
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
