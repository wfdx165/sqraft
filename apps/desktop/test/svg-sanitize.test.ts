import { describe, expect, it } from "vitest";
import { DROP_SVG_TAGS, isSafeSvgHref, isSafeSvgStyle, sanitizeSvgStyleText } from "../src/renderer/canvas/svg-sanitize";

describe("SVG 导入净化策略", () => {
  it("外部 href 丢弃，本地引用与图片 data URI 保留", () => {
    expect(isSafeSvgHref("#gradient")).toBe(true);
    expect(isSafeSvgHref("  #local  ")).toBe(true);
    expect(isSafeSvgHref("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeSvgHref("https://evil.example/x.png")).toBe(false);
    expect(isSafeSvgHref("//evil.example/x.png")).toBe(false);
    expect(isSafeSvgHref("/etc/passwd")).toBe(false);
    expect(isSafeSvgHref("javascript:alert(1)")).toBe(false);
    expect(isSafeSvgHref("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("内联 style 只接受本地 url(#…) 与 data:image", () => {
    expect(isSafeSvgStyle("fill: url(#paint); stroke: red")).toBe(true);
    expect(isSafeSvgStyle("fill: url('#paint')")).toBe(true);
    expect(isSafeSvgStyle("background: url(data:image/png;base64,AAAA)")).toBe(true);
    expect(isSafeSvgStyle("background: url(https://evil.example/x.png)")).toBe(false);
    expect(isSafeSvgStyle("background: url('/relative.png')")).toBe(false);
    expect(isSafeSvgStyle("background: url(data:text/html,x)")).toBe(false);
  });

  it("style 文本去掉 @import 与外链 url", () => {
    const css = '@import url("https://evil.example/a.css"); .a { fill: url(#ok); } .b { background: url(https://x/y.png); }';
    const cleaned = sanitizeSvgStyleText(css);
    expect(cleaned).not.toContain("@import");
    expect(cleaned).not.toContain("https://");
    expect(cleaned).toContain("url(#ok)");
  });

  it("危险标签清单覆盖脚本、HTML 容器、插件与动画", () => {
    for (const tag of ["script", "foreignobject", "iframe", "object", "embed", "handler", "animate", "set"]) {
      expect(DROP_SVG_TAGS.has(tag)).toBe(true);
    }
    expect(DROP_SVG_TAGS.has("g")).toBe(false);
  });
});
