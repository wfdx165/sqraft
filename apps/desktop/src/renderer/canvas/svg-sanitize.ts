/**
 * SVG 导入前的净化策略：即将插进真实 DOM 的克隆不能带可执行内容，
 * 也不能带会触发外部请求的资源引用（规格：丢弃 script / on* / javascript:）。
 *
 * 纯判断单独导出，便于在 Node 下测试；DOM 遍历集中在 `sanitizeSvgSubtree`。
 */
export const DROP_SVG_TAGS: ReadonlySet<string> = new Set([
  "script",
  "foreignobject",
  "handler",
  "iframe",
  "object",
  "embed",
  // 动画可以在插入后改写 href / 属性，度量阶段不需要
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "discard",
]);

/** 只保留本地引用与图片 data URI；外部 http/相对路径一律丢弃。 */
export function isSafeSvgHref(value: string): boolean {
  const href = value.trim();
  return href.startsWith("#") || href.startsWith("data:image/");
}

const STYLE_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/** 内联 style 里只允许 url(#local) 与 data:image：外部背景图/字体会发请求。 */
export function isSafeSvgStyle(value: string): boolean {
  for (const match of value.matchAll(STYLE_URL)) {
    const target = (match[2] ?? "").trim();
    if (!target.startsWith("#") && !target.startsWith("data:image/")) return false;
  }
  return true;
}

/** 序列化 `<style>` 前去掉 @import 与外链 url()（本地 # 与 data:image 保留）。 */
export function sanitizeSvgStyleText(text: string): string {
  return text
    .replace(/@import[^;]*;?/gi, "")
    .replace(STYLE_URL, (full, _quote: string, target: string) => {
      const trimmed = target.trim();
      return trimmed.startsWith("#") || trimmed.startsWith("data:image/") ? full : "none";
    });
}

export function sanitizeSvgSubtree(source: Element): Element {
  const clone = source.cloneNode(true) as Element;
  const all = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (const element of all) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        if (!isSafeSvgHref(attribute.value)) element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style" && !isSafeSvgStyle(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  for (const element of all) {
    if (DROP_SVG_TAGS.has(element.tagName.toLowerCase())) element.remove();
  }
  return clone;
}
