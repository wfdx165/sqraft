// @vitest-environment jsdom
/**
 * `parseSvg` 的编排层回归：忽略标签、透明容器、use/symbol、嵌套 svg、上限。
 *
 * jsdom 没有 canvas / getBBox，所以这里只覆盖不会触发栅格化的路径；
 * 根 `<svg filter>` 这类要走真实渲染的降级留给发布手点（见 v0.0.9 发布说明）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { parseSvg, type ParsedSvg } from "../src/renderer/canvas/svg-import";

beforeAll(() => {
  // 颜色归一化会探测 2D canvas：jsdom 没实现，固定返回 null 走字符串兜底（也顺便静音 not-implemented 报错）
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { value: () => null, configurable: true });
});

function svg(body: string, attrs = 'width="200" height="120"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
}

async function parseOk(source: string): Promise<ParsedSvg> {
  const outcome = await parseSvg(source);
  if (outcome.status !== "ok") {
    throw new Error(`期望导入成功，实际是 ${outcome.status}（${"reason" in outcome ? outcome.reason : ""}）`);
  }
  return outcome.result;
}

function rects(count: number): string {
  let body = "";
  for (let i = 0; i < count; i += 1) {
    body += `<rect x="${i % 1000}" y="${Math.floor(i / 1000) * 10}" width="5" height="5" fill="#888888"/>`;
  }
  return body;
}

describe("SVG 导入编排：忽略与透明容器", () => {
  it("script / foreignObject 只丢弃自身，其余照常落地", async () => {
    const result = await parseOk(
      svg(
        '<script>window.__pwned = 1;</script>' +
          '<foreignObject x="0" y="0" width="40" height="20"><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>' +
          '<rect x="10" y="10" width="50" height="50" fill="#123456"/>',
      ),
    );
    expect(result.nodes.map((node) => node.type)).toEqual(["rect"]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["IGNORED_TAG", "IGNORED_TAG"]);
    expect(result.warnings.map((warning) => warning.element)).toEqual(["script", "foreignobject"]);
  });

  it("a 是透明容器，内容照常解析", async () => {
    const result = await parseOk(svg('<a href="https://example.com"><rect width="50" height="50" fill="#123456"/></a>'));
    expect(result.nodes.map((node) => node.type)).toEqual(["rect"]);
    expect(result.warnings).toEqual([]);
  });

  it("switch 只取第一个可渲染分支", async () => {
    const result = await parseOk(
      svg(
        '<switch><rect id="first" width="10" height="10" fill="#111111"/><rect id="second" width="10" height="10" fill="#222222"/></switch>',
      ),
    );
    expect(result.nodes.map((node) => node.name)).toEqual(["first"]);
  });

  it("未知标签只跳过自己，兄弟节点不受影响", async () => {
    const result = await parseOk(
      svg('<foo><rect width="10" height="10"/></foo><rect id="keep" width="5" height="5" fill="#000000"/>'),
    );
    expect(result.nodes.map((node) => node.name)).toEqual(["keep"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: "UNSUPPORTED_ELEMENT", element: "foo" });
  });

  it("只有被忽略内容时回退，并保留 warnings", async () => {
    const outcome = await parseSvg(svg("<script>window.x = 1;</script>"));
    expect(outcome.status).toBe("fallback");
    if (outcome.status !== "fallback") throw new Error("unreachable");
    expect(outcome.reason).toBe("empty-content");
    expect(outcome.warnings.map((warning) => warning.code)).toEqual(["IGNORED_TAG"]);
  });
});

describe("SVG 导入编排：use / symbol / 嵌套 svg", () => {
  it("use 的 x/y 对形状目标是平移", async () => {
    const result = await parseOk(
      svg('<rect id="r" x="60" y="10" width="60" height="30" fill="#123456"/><use href="#r" x="0" y="60"/>'),
    );
    expect(result.nodes.map((node) => node.y)).toEqual([10, 70]);
  });

  it("symbol 按 use 的宽高缩放，容器上的线宽跟着缩放", async () => {
    const result = await parseOk(
      svg(
        '<symbol id="s" viewBox="0 0 10 10" stroke-width="1"><rect width="10" height="10" fill="none" stroke="#000000"/></symbol><use href="#s" width="100" height="100"/>',
      ),
    );
    const shape = result.nodes.find((node) => node.type === "path");
    expect(shape?.style?.strokeWidth).toBeCloseTo(10, 6);
  });

  it("嵌套 svg 套 x/y 与 viewBox 缩放，嵌套 svg 上的线宽同样缩放", async () => {
    const result = await parseOk(
      svg(
        '<svg x="50" y="50" width="100" height="100" viewBox="0 0 10 10" stroke-width="1">' +
          '<rect width="10" height="10" fill="none" stroke="#000000"/></svg>',
        'width="200" height="200"',
      ),
    );
    const shape = result.nodes.find((node) => node.type === "path");
    expect(shape).toMatchObject({ x: 50, y: 50, width: 100, height: 100 });
    expect(shape?.style?.strokeWidth).toBeCloseTo(10, 6);
  });

  it("symbol 环引用只跳过，不会无限展开", async () => {
    const result = await parseOk(
      svg('<symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/><use href="#s"/></symbol><use href="#s" width="10" height="10"/>'),
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.message.includes("cycle"))).toBe(true);
  });
});

describe("SVG 导入编排：多轮廓", () => {
  it("多子路径 + 填充落成一个多轮廓 path，fill-rule 保留", async () => {
    const result = await parseOk(
      svg('<path fill="#123456" fill-rule="evenodd" d="M10 10 H90 V90 H10 Z M35 35 H65 V65 H35 Z"/>'),
    );
    expect(result.nodes).toHaveLength(1);
    const shape = result.nodes[0];
    expect(shape.type).toBe("path");
    expect(shape.vector?.contours).toHaveLength(2);
    expect(shape.vector?.fillRule).toBe("evenodd");
    expect(shape.vector?.contours.every((contour) => contour.closed)).toBe(true);
  });

  it("没有 fill-rule 的多子路径按 nonzero 落库", async () => {
    const result = await parseOk(svg('<path fill="#123456" d="M0 0 H20 V20 H0 Z M5 5 H15 V15 H5 Z"/>'));
    const shape = result.nodes[0];
    expect(shape.vector?.contours).toHaveLength(2);
    expect(shape.vector?.fillRule).toBe("nonzero");
  });

  it("多子路径的描边也只产生一个节点", async () => {
    const result = await parseOk(svg('<path fill="none" stroke="#111111" d="M0 0 L10 0 M20 20 L30 20"/>'));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].vector?.contours).toHaveLength(2);
    expect(result.nodes[0].vector?.contours.every((contour) => !contour.closed)).toBe(true);
  });
});

describe("SVG 导入编排：上限", () => {
  it("超过 3000 节点整份失败，并给出上限", async () => {
    const outcome = await parseSvg(svg(rects(3001), 'width="1000" height="100"'));
    expect(outcome.status).toBe("fallback");
    if (outcome.status !== "fallback") throw new Error("unreachable");
    expect(outcome).toMatchObject({ reason: "node-limit", limit: 3000 });
  });

  it("上限之后的 script / defs 不触发超限", async () => {
    const result = await parseOk(svg(`${rects(3000)}<script>x</script><defs><linearGradient id="g"/></defs>`, 'width="1000" height="100"'));
    expect(result.nodes).toHaveLength(3000);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["IGNORED_TAG"]);
  });
});
