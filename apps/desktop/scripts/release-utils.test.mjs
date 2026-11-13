import { describe, expect, it } from "vitest";
import { compareVersions, pickArm64Dmg, pickArm64Zip, pickWinSetup } from "./release-utils.mjs";

describe("发布产物匹配", () => {
  it("接受 electron-builder 默认的 -mac zip 后缀", () => {
    const names = ["Sqraft-0.0.2-arm64-mac.zip", "Sqraft-0.0.2-arm64-mac.zip.blockmap"];
    expect(pickArm64Zip(names, "0.0.2")).toBe("Sqraft-0.0.2-arm64-mac.zip");
  });

  it("也接受不带 -mac 的 zip，并忽略 blockmap", () => {
    expect(pickArm64Zip(["Sqraft-0.0.2-arm64.zip"], "0.0.2")).toBe("Sqraft-0.0.2-arm64.zip");
    expect(pickArm64Zip(["Sqraft-0.0.2-arm64.zip.blockmap"], "0.0.2")).toBeNull();
  });

  it("只匹配当前版本，并正确找到 dmg", () => {
    expect(pickArm64Zip(["Sqraft-0.0.1-arm64-mac.zip"], "0.0.2")).toBeNull();
    expect(pickArm64Dmg(["Sqraft-0.0.2-arm64.dmg"], "0.0.2")).toBe("Sqraft-0.0.2-arm64.dmg");
  });

  it("Windows 只认当前版本的 Setup exe", () => {
    const names = ["Sqraft-Setup-0.0.2.exe", "Sqraft-Setup-0.0.2.exe.blockmap", "Sqraft-Setup-0.0.2.exe.sha256"];
    expect(pickWinSetup(names, "0.0.2")).toBe("Sqraft-Setup-0.0.2.exe");
    expect(pickWinSetup(["Sqraft-Setup-0.0.1.exe"], "0.0.2")).toBeNull();
    expect(pickWinSetup(["Sqraft Setup 0.0.2.exe"], "0.0.2")).toBeNull();
  });
});

describe("版本比较", () => {
  it("按数字段比较", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("v0.0.3", "0.0.3")).toBe(0);
    expect(compareVersions("0.0.2", "0.0.3")).toBe(-1);
  });
});
