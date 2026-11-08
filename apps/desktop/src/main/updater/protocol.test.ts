import { describe, expect, it } from "vitest";
import { appBundlePathOf, buildInstallScript, installPathsOf, type ScriptOptions } from "./install";
import { compareVersions, isTrustedUpdateUrl, parseLatest, UpdateManifestError } from "./protocol";

const sha = "a".repeat(64);
const asset = (overrides: Record<string, unknown> = {}) => ({
  url: "https://github.com/wfdx165/sqraft/releases/download/v0.1.0/Sqraft-0.1.0-arm64.zip",
  sha256: sha,
  ...overrides,
});

function errorKey(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateManifestError);
    return (error as UpdateManifestError).key;
  }
  throw new Error("expected parseLatest to throw");
}

describe("版本比较", () => {
  it("按段比较，不被字符串顺序骗", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("v0.2.0", "0.1.9")).toBe(1);
  });

  it("同号正式版高于预发布版", () => {
    expect(compareVersions("0.1.0", "0.1.0-beta.1")).toBe(1);
    expect(compareVersions("0.1.0-beta.1", "0.1.0-beta.2")).toBe(-1);
  });

  it("脏数据当 0 处理，不抛错", () => {
    expect(compareVersions("", "0.0.1")).toBe(-1);
    expect(compareVersions("abc", "0.0.0")).toBe(0);
  });
});

describe("下载地址白名单", () => {
  it("只放行 https + GitHub 域名", () => {
    expect(isTrustedUpdateUrl("https://github.com/a/b/releases/download/v1/x.zip")).toBe(true);
    expect(isTrustedUpdateUrl("https://objects.githubusercontent.com/abc")).toBe(true);
    expect(isTrustedUpdateUrl("http://github.com/a/b")).toBe(false);
    expect(isTrustedUpdateUrl("https://evil.example.com/x.zip")).toBe(false);
    expect(isTrustedUpdateUrl("https://github.com.evil.com/x.zip")).toBe(false);
  });
});

describe("latest.json 校验", () => {
  it("接受合法清单", () => {
    const manifest = parseLatest({
      version: "0.1.0",
      publishedAt: "2026-11-03T00:00:00Z",
      notes: "第一版",
      assets: { "mac-arm64": asset(), "mac-arm64-dmg": asset({ url: "https://github.com/a/b/x.dmg" }) },
    });
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.assets["mac-arm64"].sha256).toBe(sha);
  });

  it("版本号不合法直接拒绝", () => {
    expect(errorKey(() => parseLatest({ version: "latest", assets: { "mac-arm64": asset() } }))).toBe(
      "update.manifestVersion",
    );
  });

  it("缺 mac-arm64 或 sha256 不对都拒绝", () => {
    expect(errorKey(() => parseLatest({ version: "0.1.0", assets: {} }))).toBe("update.manifestAsset");
    expect(
      errorKey(() => parseLatest({ version: "0.1.0", assets: { "mac-arm64": asset({ sha256: "zz" }) } })),
    ).toBe("update.manifestAsset");
  });

  it("非白名单地址的资产不算数", () => {
    expect(
      errorKey(() =>
        parseLatest({ version: "0.1.0", assets: { "mac-arm64": asset({ url: "https://evil.example.com/a.zip" }) } }),
      ),
    ).toBe("update.manifestAsset");
  });

  it("非对象清单给出明确错误码", () => {
    expect(errorKey(() => parseLatest(null))).toBe("update.manifestNotObject");
  });
});

describe("安装路径与脚本", () => {
  it("从可执行文件反推 .app（只认 Contents/MacOS 结构）", () => {
    expect(appBundlePathOf("/Applications/Sqraft.app/Contents/MacOS/Sqraft")).toBe("/Applications/Sqraft.app");
    expect(appBundlePathOf("/usr/local/bin/sqraft")).toBeNull();
  });

  it("脚本包含等待、备份、回滚与启动标记判定", () => {
    const paths = installPathsOf("/Applications/Sqraft.app", "/Users/me/Library/Application Support/Sqraft");
    const options: ScriptOptions = {
      ...paths,
      pid: 1234,
      version: "0.1.0",
      appName: "Sqraft.app",
    };
    const script = buildInstallScript(options);
    expect(script).toContain("PID=1234");
    expect(script).toContain("/Applications/Sqraft.app.backup");
    expect(script).toContain("ditto -x -k");
    expect(script).toContain("启动超时，回滚");
    expect(script).toContain("Application Support");
  });

  it("含引号的路径不会破坏脚本", () => {
    const paths = installPathsOf("/Volumes/My Disk/Sqraft's.app", "/tmp/upd");
    const script = buildInstallScript({ ...paths, pid: 1, version: "0.1.0", appName: "Sqraft.app" });
    expect(script).toContain(`APP='/Volumes/My Disk/Sqraft'\\''s.app'`);
  });
});
