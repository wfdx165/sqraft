import { describe, expect, it } from "vitest";
import {
  compareVersions,
  notaryCredentialSource,
  parseVerifyPackArgs,
  pickArm64Dmg,
  pickArm64Zip,
  pickWinSetup,
} from "./release-utils.mjs";

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

describe("公证凭据来源", () => {
  it("一组都没有时返回 null", () => {
    expect(notaryCredentialSource({})).toBeNull();
  });

  it("App Store Connect API Key 三件套齐才认", () => {
    expect(
      notaryCredentialSource({
        APPLE_API_KEY: "/Users/me/.config/sqraft/AuthKey_AAA.p8",
        APPLE_API_KEY_ID: "AAA",
        APPLE_API_ISSUER: "issuer",
      }),
    ).toEqual({ kind: "api-key", keyPath: "/Users/me/.config/sqraft/AuthKey_AAA.p8" });
  });

  it("半套 API Key 报 incomplete，而不是静默跳过公证", () => {
    const result = notaryCredentialSource({ APPLE_API_KEY: "/tmp/key.p8" });
    expect(result.kind).toBe("incomplete");
    expect(result.detail).toContain("三件套不全");
  });

  it("Apple ID 三件套同样要求齐全", () => {
    expect(
      notaryCredentialSource({
        APPLE_ID: "a@b.c",
        APPLE_APP_SPECIFIC_PASSWORD: "pwd",
        APPLE_TEAM_ID: "5BJLY53QWY",
      }),
    ).toEqual({ kind: "apple-id" });
    expect(notaryCredentialSource({ APPLE_ID: "a@b.c", APPLE_TEAM_ID: "5BJLY53QWY" }).kind).toBe(
      "incomplete",
    );
  });

  it("keychain profile 与 API Key 同时存在时优先 API Key（与 electron-builder 一致）", () => {
    expect(notaryCredentialSource({ APPLE_KEYCHAIN_PROFILE: "sqraft" })).toEqual({
      kind: "keychain-profile",
    });
    expect(
      notaryCredentialSource({
        APPLE_KEYCHAIN_PROFILE: "sqraft",
        APPLE_API_KEY: "/tmp/key.p8",
        APPLE_API_KEY_ID: "AAA",
        APPLE_API_ISSUER: "issuer",
      }).kind,
    ).toBe("api-key");
  });
});

describe("verify-pack 参数解析", () => {
  it("默认：无产物路径、不断言签名", () => {
    expect(parseVerifyPackArgs([])).toEqual({ target: null, expectSigned: false, expectedTeam: "" });
  });

  it("发版时 dist / release 会传的组合", () => {
    expect(parseVerifyPackArgs(["dist/mac/Sqraft.app", "--expect-signed", "--team-id", "5BJLY53QWY"])).toEqual({
      target: "dist/mac/Sqraft.app",
      expectSigned: true,
      expectedTeam: "5BJLY53QWY",
    });
  });

  it("--team-id 缺值必须报错，不能静默跳过 Team 比对", () => {
    expect(parseVerifyPackArgs(["--team-id"]).error).toContain("需要一个 Team ID");
    expect(parseVerifyPackArgs(["--team-id", "--expect-signed"]).error).toContain("需要一个 Team ID");
  });

  it("未知参数与多余路径都报错", () => {
    expect(parseVerifyPackArgs(["--signed"]).error).toContain("不认识的参数");
    expect(parseVerifyPackArgs(["a.app", "b.app"]).error).toContain("只能指定一个产物路径");
  });
});
