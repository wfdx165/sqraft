import { describe, expect, it } from "vitest";
import { imageUserAgent } from "./ua";

describe("抓图请求的 User-Agent", () => {
  it("不含 Electron 标识，末尾标明 Sqraft 版本", () => {
    const ua = imageUserAgent("darwin", "156.0.8078.49", "0.0.1");
    expect(ua).not.toContain("Electron");
    expect(ua).toContain("Chrome/156.0.8078.49");
    expect(ua).toContain("Sqraft/0.0.1");
  });

  it("保留浏览器底味（防 CDN 拦截），按平台换源串", () => {
    const mac = imageUserAgent("darwin", "156.0.8078.49", "0.0.1");
    const win = imageUserAgent("win32", "156.0.8078.49", "0.0.1");
    const linux = imageUserAgent("linux", "156.0.8078.49", "0.0.1");
    for (const ua of [mac, win, linux]) {
      expect(ua).toMatch(/^Mozilla\/5\.0 \(.*\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\//);
    }
    expect(win).toContain("Windows NT 10.0");
    expect(linux).toContain("X11; Linux x86_64");
  });

  it("拿不到 Chromium 版本时不拼半截 UA", () => {
    const ua = imageUserAgent("darwin", "", "0.0.1");
    expect(ua).not.toContain("Chrome/");
    expect(ua).toContain("Safari/537.36 Sqraft/0.0.1");
  });
});
