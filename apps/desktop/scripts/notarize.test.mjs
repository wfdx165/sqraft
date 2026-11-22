import { describe, expect, it } from "vitest";
import {
  NOTARY_TIMEOUT_MS,
  formatDuration,
  isNotaryAccepted,
  isNotaryFailure,
  isNotaryTimedOut,
  normalizeNotaryStatus,
  notaryAuthArgs,
  parseNotaryJson,
  parseNotaryState,
  planNotarization,
  summarizeNotaryLog,
} from "./notarize.mjs";

const API_ENV = {
  APPLE_API_KEY: "/Users/me/.config/sqraft/AuthKey_AAA.p8",
  APPLE_API_KEY_ID: "AAA",
  APPLE_API_ISSUER: "issuer-uuid",
};

describe("公证鉴权参数", () => {
  it("API Key：.p8 路径来自凭据，id / issuer 来自 env", () => {
    expect(notaryAuthArgs({ kind: "api-key", keyPath: API_ENV.APPLE_API_KEY }, API_ENV)).toEqual([
      "--key",
      API_ENV.APPLE_API_KEY,
      "--key-id",
      "AAA",
      "--issuer",
      "issuer-uuid",
    ]);
  });

  it("Apple ID 三件套与 keychain profile 各走一套参数", () => {
    expect(
      notaryAuthArgs(
        { kind: "apple-id" },
        { APPLE_ID: "a@b.c", APPLE_APP_SPECIFIC_PASSWORD: "pwd", APPLE_TEAM_ID: "TEAM123456" },
      ),
    ).toEqual(["--apple-id", "a@b.c", "--password", "pwd", "--team-id", "TEAM123456"]);
    expect(notaryAuthArgs({ kind: "keychain-profile" }, { APPLE_KEYCHAIN_PROFILE: "sqraft" })).toEqual([
      "--keychain-profile",
      "sqraft",
    ]);
  });

  it("缺凭据 / 半套凭证直接报错，不把空参数交给 notarytool", () => {
    expect(() => notaryAuthArgs(null, {})).toThrow("缺少公证凭据");
    expect(() => notaryAuthArgs({ kind: "incomplete", detail: "三件套不全" }, {})).toThrow(
      "三件套不全",
    );
    expect(() => notaryAuthArgs({ kind: "api-key", keyPath: "/tmp/a.p8" }, { APPLE_API_KEY_ID: "AAA" })).toThrow(
      "三件套不全",
    );
  });
});

describe("notarytool 输出解析", () => {
  it("纯 JSON 直接解析，混着进度行时截取第一个 { 到最后一个 }", () => {
    expect(parseNotaryJson('{"id":"abc","status":"In Progress"}')).toEqual({
      id: "abc",
      status: "In Progress",
    });
    expect(
      parseNotaryJson('Conducting pre-submission checks...\n{"id":"abc","status":"Accepted"}\n'),
    ).toEqual({ id: "abc", status: "Accepted" });
    expect(parseNotaryJson("")).toBeNull();
    expect(parseNotaryJson("no json here")).toBeNull();
  });

  it("状态大小写不敏感；终态只有 Accepted 算成功", () => {
    expect(normalizeNotaryStatus("in progress")).toBe("In Progress");
    expect(normalizeNotaryStatus("accepted")).toBe("Accepted");
    expect(normalizeNotaryStatus("")).toBe("Unknown");
    expect(isNotaryAccepted("accepted")).toBe(true);
    expect(isNotaryFailure("Invalid")).toBe(true);
    expect(isNotaryFailure("Rejected")).toBe(true);
    expect(isNotaryFailure("In Progress")).toBe(false);
  });

  it("超时判定与耗时格式", () => {
    expect(isNotaryTimedOut(0, NOTARY_TIMEOUT_MS - 1)).toBe(false);
    expect(isNotaryTimedOut(0, NOTARY_TIMEOUT_MS)).toBe(true);
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(3_600_000)).toBe("60m00s");
  });

  it("notarytool log 的 issues 压成人话；没有 issues 时返回空数组", () => {
    const log = JSON.stringify({
      issues: [
        { severity: "error", message: "The binary is not signed", path: "Sqraft.app/Contents/MacOS/Sqraft" },
        { message: "Invalid bundle structure" },
      ],
    });
    expect(summarizeNotaryLog(log)).toEqual([
      "[error] The binary is not signed（Sqraft.app/Contents/MacOS/Sqraft）",
      "[error] Invalid bundle structure",
    ]);
    expect(summarizeNotaryLog('{"issues":[]}')).toEqual([]);
    expect(summarizeNotaryLog("not json")).toEqual([]);
  });

  it("notary.json 不是合法对象时当作不存在", () => {
    expect(parseNotaryState('{"submissionId":"abc"}')).toEqual({ submissionId: "abc" });
    expect(parseNotaryState("[1,2]")).toEqual([1, 2]);
    expect(parseNotaryState("")).toBeNull();
    expect(parseNotaryState("{broken")).toBeNull();
    expect(parseNotaryState('"text"')).toBeNull();
  });
});

describe("续跑计划", () => {
  const appPath = "/repo/release/mac-arm64/Sqraft.app";
  const cdHash = "aaaa";

  it("没有状态、换了 .app、或 CDHash 变了 → 重新提交", () => {
    expect(planNotarization({ state: null, appPath, cdHash }).action).toBe("submit");
    expect(
      planNotarization({ state: { submissionId: "1", status: "In Progress", appPath: "/other.app" }, appPath, cdHash })
        .action,
    ).toBe("submit");
    expect(
      planNotarization({
        state: { submissionId: "1", status: "In Progress", appPath, cdHash: "bbbb" },
        appPath,
        cdHash,
      }).action,
    ).toBe("submit");
  });

  it("Accepted 且已 staple → 完成（staple 不改 CDHash，重复执行安全）", () => {
    expect(
      planNotarization({
        state: { submissionId: "1", status: "Accepted", appPath, cdHash, stapledAt: "2026-11-22T00:00:00Z" },
        appPath,
        cdHash,
      }).action,
    ).toBe("done");
  });

  it("Accepted 但没 staple → 只补 staple；In Progress → 继续轮询", () => {
    expect(
      planNotarization({
        state: { submissionId: "1", status: "Accepted", appPath, cdHash },
        appPath,
        cdHash,
      }),
    ).toEqual({ action: "staple", submissionId: "1" });
    expect(
      planNotarization({
        state: { submissionId: "1", status: "In Progress", appPath, cdHash },
        appPath,
        cdHash,
      }),
    ).toEqual({ action: "poll", submissionId: "1" });
  });

  it("Invalid / Rejected → 失败，不重复提交同一个包", () => {
    expect(
      planNotarization({
        state: { submissionId: "1", status: "Invalid", appPath, cdHash },
        appPath,
        cdHash,
      }),
    ).toEqual({ action: "failed", submissionId: "1" });
  });
});
