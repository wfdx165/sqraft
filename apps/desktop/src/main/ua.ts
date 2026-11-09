/**
 * 对外请求的 User-Agent（链接图抓取）。
 *
 * Electron 默认 UA 形如 `… Chrome/156.0.8078.49 Safari/537.36 Electron/45.1.0`——
 * `Electron/<版本>` 会把本机身份直接告诉每个图床服务器。这里重新拼一个：
 * 去掉 Electron 词、保留浏览器底味（不少 CDN 会把非浏览器 UA 当爬虫拦掉，直接图裂），
 * 末尾追加 `Sqraft/<版本>` 标明真实身份。
 *
 * `chrome` 版本取 `process.versions.chrome`，所以 Electron 升级后这里自动跟上，不用手改。
 */
export function imageUserAgent(platform: NodeJS.Platform, chromeVersion: string, appVersion: string): string {
  const source =
    platform === "win32" ? "Windows NT 10.0; Win64; x64" : platform === "linux" ? "X11; Linux x86_64" : "Macintosh; Intel Mac OS X 10_15_7";
  // 拿不到 Chromium 版本时整段省略，避免拼出 `Chrome/ ` 这种半截 UA
  const engine = chromeVersion ? `Chrome/${chromeVersion} ` : "";
  return `Mozilla/5.0 (${source}) AppleWebKit/537.36 (KHTML, like Gecko) ${engine}Safari/537.36 Sqraft/${appVersion}`;
}
