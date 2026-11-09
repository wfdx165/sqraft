/**
 * 链接图片的地址校验（纯函数，不碰 Electron，便于单测）。
 *
 * 只拦真正有意义的一类：链路本地地址（169.254/16、fe80::/10，云元数据与 APIPA）。
 * 本机与私网放行——本地开发服务器、NAS 图床都是正常用法。
 */

/** http/https 才允许抓取；`file:` `data:` 一律拒绝。 */
export function isHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

/** 链路本地地址（含 IPv4-mapped IPv6）。 */
export function isLinkLocalAddress(address: string): boolean {
  if (address.startsWith("169.254.")) return true;
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:169.254.")) return true;
  return lower.startsWith("fe80:");
}
