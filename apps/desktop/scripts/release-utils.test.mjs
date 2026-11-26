import { describe, expect, it } from "vitest";
import {
  MACOS_BASELINE,
  MAC_ARCHES,
  archFromAppPath,
  compareVersions,
  macOutDirName,
  minOSProblems,
  normalizeMinOS,
  notaryCredentialSource,
  parseVerifyPackArgs,
  pickMacDmg,
  pickMacZip,
  pickWinSetup,
  planResumeArches,
  signingProblems,
} from "./release-utils.mjs";

describe("发布产物匹配", () => {
  it("按架构匹配 zip，并忽略 blockmap", () => {
    const names = ["Sqraft-0.1.2-arm64.zip", "Sqraft-0.1.2-x64.zip", "Sqraft-0.1.2-arm64.zip.blockmap"];
    expect(pickMacZip(names, "0.1.2", "arm64")).toBe("Sqraft-0.1.2-arm64.zip");
    expect(pickMacZip(names, "0.1.2", "x64")).toBe("Sqraft-0.1.2-x64.zip");
    expect(pickMacZip(["Sqraft-0.1.2-arm64.zip.blockmap"], "0.1.2", "arm64")).toBeNull();
  });

  it("兼容 0.1.1 的 -arm64-mac.zip，但不把它当成 x64", () => {
    expect(pickMacZip(["Sqraft-0.1.1-arm64-mac.zip"], "0.1.1", "arm64")).toBe(
      "Sqraft-0.1.1-arm64-mac.zip",
    );
    expect(pickMacZip(["Sqraft-0.1.1-arm64-mac.zip"], "0.1.1", "x64")).toBeNull();
  });

  it("只匹配当前版本，并按架构找 dmg", () => {
    expect(pickMacZip(["Sqraft-0.1.1-arm64-mac.zip"], "0.1.2", "arm64")).toBeNull();
    expect(
      pickMacDmg(["Sqraft-0.1.2-arm64.dmg", "Sqraft-0.1.2-x64.dmg"], "0.1.2", "x64"),
    ).toBe("Sqraft-0.1.2-x64.dmg");
    expect(pickMacDmg(["Sqraft-0.1.2-arm64.dmg"], "0.1.2", "x64")).toBeNull();
  });

  it("Windows 只认当前版本的 Setup exe", () => {
    const names = ["Sqraft-Setup-0.0.2.exe", "Sqraft-Setup-0.0.2.exe.blockmap", "Sqraft-Setup-0.0.2.exe.sha256"];
    expect(pickWinSetup(names, "0.0.2")).toBe("Sqraft-Setup-0.0.2.exe");
    expect(pickWinSetup(["Sqraft-Setup-0.0.1.exe"], "0.0.2")).toBeNull();
    expect(pickWinSetup(["Sqraft Setup 0.0.2.exe"], "0.0.2")).toBeNull();
  });
});

describe("架构目录", () => {
  it("arm64 → mac-arm64，x64 → mac；未知架构直接报错", () => {
    expect(MAC_ARCHES).toEqual(["arm64", "x64"]);
    expect(macOutDirName("arm64")).toBe("mac-arm64");
    expect(macOutDirName("x64")).toBe("mac");
    expect(() => macOutDirName("ia32")).toThrow();
  });

  it("从 .app 路径反推架构", () => {
    expect(archFromAppPath("/repo/release/mac-arm64/Sqraft.app")).toBe("arm64");
    expect(archFromAppPath("/repo/release/mac/Sqraft.app")).toBe("x64");
  });
});

describe("版本比较", () => {
  it("按数字段比较", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("v0.0.3", "0.0.3")).toBe(0);
    expect(compareVersions("0.0.2", "0.0.3")).toBe(-1);
  });
});

describe("minOS 发布闸门", () => {
  it("缺省/null 返回 null，合法版本原样返回", () => {
    expect(MACOS_BASELINE).toBe("11.0");
    expect(normalizeMinOS(undefined)).toBeNull();
    expect(normalizeMinOS(null)).toBeNull();
    expect(normalizeMinOS("12.0")).toBe("12.0");
    expect(normalizeMinOS(" 12 ")).toBe("12");
    expect(normalizeMinOS("12.0.1")).toBe("12.0.1");
  });

  it("非法值直接抛错", () => {
    for (const value of ["", "12.x", "12.0-beta", 12, {}, []]) {
      expect(() => normalizeMinOS(value)).toThrow(/minOS/);
    }
  });

  it("两个架构的 floor 不一致 → 中止", () => {
    expect(minOSProblems({ minOS: "11.0", floors: ["11.0", "12.0"] })).toHaveLength(1);
  });

  it("0.1.2：floor 11.0 + minOS null → 通过", () => {
    expect(minOSProblems({ minOS: null, floors: ["11.0", "11.0"] })).toEqual([]);
  });

  it("抬了 floor 却没填 minOS → 中止", () => {
    expect(minOSProblems({ minOS: null, floors: ["12.0", "12.0"] })[0]).toContain("minOS 为空");
  });

  it("minOS 低于 floor → 中止；等于/高于 → 通过", () => {
    expect(minOSProblems({ minOS: "11.7", floors: ["12.0", "12.0"] })[0]).toContain("低于");
    expect(minOSProblems({ minOS: "12.0", floors: ["12.0", "12.0"] })).toEqual([]);
    expect(minOSProblems({ minOS: "12.1", floors: ["12.0", "12.0"] })).toEqual([]);
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

describe("发版签名 / 公证闸门", () => {
  const signed = { identity: "Developer ID Application: X (TEAM)", teamId: "5BJLY53QWY" };

  it("dist:dir / 签名上线前的产物：没有 signing", () => {
    expect(signingProblems(null)[0]).toContain("没有完整的签名信息");
    expect(signingProblems({ identity: "" })[0]).toContain("没有完整的签名信息");
  });

  it("签名齐全但未公证：拒收（--no-notarize 的应急包发不出去）", () => {
    const problems = signingProblems({ ...signed, notarized: false });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("signing.notarized 不是 true");
  });

  it("签名 + 公证都齐全才放行", () => {
    expect(signingProblems({ ...signed, notarized: true })).toEqual([]);
  });
});

describe("verify-pack 参数解析", () => {
  it("默认：无产物路径、不断言签名、不断言架构", () => {
    expect(parseVerifyPackArgs([])).toEqual({
      target: null,
      expectSigned: false,
      expectNotarized: false,
      expectedTeam: "",
      expectedArch: "",
    });
  });

  it("发版时 dist / release 会传的组合", () => {
    expect(
      parseVerifyPackArgs([
        "dist/mac-arm64/Sqraft.app",
        "--arch",
        "arm64",
        "--expect-signed",
        "--team-id",
        "5BJLY53QWY",
      ]),
    ).toEqual({
      target: "dist/mac-arm64/Sqraft.app",
      expectSigned: true,
      expectNotarized: false,
      expectedTeam: "5BJLY53QWY",
      expectedArch: "arm64",
    });
  });

  it("恢复公证后多一个 --expect-notarized", () => {
    expect(parseVerifyPackArgs(["Sqraft.app", "--expect-signed", "--expect-notarized", "--team-id", "5BJLY53QWY"])).toEqual({
      target: "Sqraft.app",
      expectSigned: true,
      expectNotarized: true,
      expectedTeam: "5BJLY53QWY",
      expectedArch: "",
    });
  });

  it("--arch 只认 arm64 / x64，缺值或写错都报错", () => {
    expect(parseVerifyPackArgs(["Sqraft.app", "--arch", "x64"]).expectedArch).toBe("x64");
    expect(parseVerifyPackArgs(["--arch"]).error).toContain("只认 arm64 / x64");
    expect(parseVerifyPackArgs(["--arch", "ia32"]).error).toContain("只认 arm64 / x64");
    expect(parseVerifyPackArgs(["--arch", "--expect-signed"]).error).toContain("只认 arm64 / x64");
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

describe("dist:resume 的逐架构计划", () => {
  const accepted = { submissionId: "1", status: "Accepted", stapledAt: "2026-01-01T00:00:00Z" };
  const running = { submissionId: "2", status: "In Progress" };

  it("arm64 已公证、x64 连 .app 都没有 → x64 补完整构建", () => {
    const plan = planResumeArches({ states: { arm64: accepted }, appExists: (arch) => arch === "arm64" });
    expect(plan).toEqual([
      { arch: "arm64", action: "repack" },
      { arch: "x64", action: "build" },
    ]);
  });

  it("x64 已公证、arm64 没有 → arm64 补完整构建（顺序固定 arm64 在前）", () => {
    const plan = planResumeArches({ states: { x64: accepted }, appExists: (arch) => arch === "x64" });
    expect(plan).toEqual([
      { arch: "arm64", action: "build" },
      { arch: "x64", action: "repack" },
    ]);
  });

  it(".app 在但公证超时 / 从没提交 → 只补公证", () => {
    expect(
      planResumeArches({ states: { arm64: accepted, x64: running }, appExists: () => true }),
    ).toEqual([
      { arch: "arm64", action: "repack" },
      { arch: "x64", action: "notarize" },
    ]);
    expect(
      planResumeArches({ states: { arm64: accepted }, appExists: () => true })[1],
    ).toEqual({ arch: "x64", action: "notarize" });
  });

  it("什么都没留下 → 两个架构都要构建（调用方据此拒绝续跑）", () => {
    expect(planResumeArches({ states: {}, appExists: () => false })).toEqual([
      { arch: "arm64", action: "build" },
      { arch: "x64", action: "build" },
    ]);
  });
});
