import { describe, expect, it } from "vitest";
import { isHttpUrl, isLinkLocalAddress } from "../src/main/image-url";

describe("链接图片的地址校验", () => {
  it("只接受 http / https", () => {
    expect(isHttpUrl("https://cdn.example.com/a.png")?.protocol).toBe("https:");
    expect(isHttpUrl("http://localhost:3000/a.png")?.protocol).toBe("http:");
    expect(isHttpUrl("file:///etc/passwd")).toBeNull();
    expect(isHttpUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(isHttpUrl("ftp://a/b.png")).toBeNull();
    expect(isHttpUrl("不是地址")).toBeNull();
  });

  it("拦链路本地，放行本机与私网", () => {
    expect(isLinkLocalAddress("169.254.169.254")).toBe(true);
    expect(isLinkLocalAddress("169.254.0.1")).toBe(true);
    expect(isLinkLocalAddress("::ffff:169.254.1.1")).toBe(true);
    expect(isLinkLocalAddress("fe80::1")).toBe(true);
    expect(isLinkLocalAddress("FE80::1")).toBe(true);

    expect(isLinkLocalAddress("127.0.0.1")).toBe(false);
    expect(isLinkLocalAddress("10.0.0.8")).toBe(false);
    expect(isLinkLocalAddress("192.168.1.20")).toBe(false);
    expect(isLinkLocalAddress("8.8.8.8")).toBe(false);
    expect(isLinkLocalAddress("::1")).toBe(false);
  });
});
