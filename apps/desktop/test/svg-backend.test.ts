import { describe, expect, it } from "vitest";
import { DocStore, createDocWithPage, createNode, firstPageId } from "@sqraft/core";
import { SvgBackend, drawDocument, type ResolvedImage, type Viewport } from "@sqraft/render";

const VP: Viewport = { x: 0, y: 0, width: 400, height: 300, zoom: 1, dpr: 1 };
const measure = (text: string): number => [...text].length * 10;

function render(doc: DocStore["doc"], options: Parameters<typeof drawDocument>[2] = {}, fonts = [] as never[]): string {
  const backend = new SvgBackend({ viewport: VP, measure, fonts });
  backend.beginFrame(VP);
  drawDocument(backend, doc, options);
  backend.endFrame();
  return backend.toSvg();
}

function withPage() {
  const store = new DocStore(createDocWithPage());
  const pageId = firstPageId(store.doc)!;
  return { store, pageId };
}

describe("SvgBackend：形状与结构", () => {
  it("矩形写成路径，四角圆角与描边都在", () => {
    const { store, pageId } = withPage();
    const rect = createNode("rect", {
      parentId: pageId,
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      style: { fill: { value: "#3366ff" }, stroke: { value: "#000" }, strokeWidth: 2 },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const svg = render(store.doc);
    expect(svg).toContain('width="400"');
    expect(svg).toContain('viewBox="0 0 400 300"');
    expect(svg).toContain('fill="#3366ff"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg).toContain("M10 20");
  });

  it("旋转写成 rotate(角度 中心)", () => {
    const { store, pageId } = withPage();
    const rect = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 100, height: 40, rotation: 30 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const svg = render(store.doc);
    expect(svg).toContain("rotate(30 50 20)");
  });

  it("子节点在父容器的 translate 组里", () => {
    const { store, pageId } = withPage();
    const frame = createNode("frame", { parentId: pageId, x: 100, y: 50, width: 200, height: 100 });
    const child = createNode("rect", { parentId: frame.id, x: 10, y: 10, width: 20, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [child], parentId: frame.id } });
    const svg = render(store.doc);
    expect(svg).toContain('transform="translate(100 50)"');
    expect(svg).toContain("M10 10");
  });

  it("clip 生成 clipPath，opacity 生成组透明度", () => {
    const { store, pageId } = withPage();
    const frame = createNode("frame", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      opacity: 0.5,
      clip: true,
    });
    const child = createNode("rect", { parentId: frame.id, x: 0, y: 0, width: 10, height: 10 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [child], parentId: frame.id } });
    const svg = render(store.doc);
    expect(svg).toContain("<clipPath");
    expect(svg).toContain('clip-path="url(#clip0)"');
    expect(svg).toContain('opacity="0.5"');
  });
});

describe("SvgBackend：文本", () => {
  it("逐行输出 <text>，基线按画布同一公式", () => {
    const { store, pageId } = withPage();
    const text = createNode("text", {
      parentId: pageId,
      x: 10,
      y: 10,
      width: 200,
      text: "第一行\n第二行",
      style: { fontSize: 20, lineHeight: 30, lineHeightUnit: "px", fill: { value: "#111" } },
    });
    store.apply({ type: "node.create", params: { nodes: [text], parentId: pageId } });
    const svg = render(store.doc);
    const count = (svg.match(/<text /g) ?? []).length;
    expect(count).toBe(2);
    // 第一行基线 = 10 + (30-20)/2 + 16 = 31；第二行 = 61
    expect(svg).toContain('y="31"');
    expect(svg).toContain('y="61"');
    expect(svg).toContain('font-size="20"');
  });

  it("文本内容转义，<g> 开闭配对", () => {
    const { store, pageId } = withPage();
    const frame = createNode("frame", { parentId: pageId, x: 0, y: 0, width: 100, height: 100 });
    const text = createNode("text", {
      parentId: frame.id,
      x: 0,
      y: 0,
      width: 100,
      text: "<a & b>",
      style: { fontSize: 16 },
    });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [text], parentId: frame.id } });
    const svg = render(store.doc);
    expect(svg).toContain("&lt;a &amp; b&gt;");
    expect((svg.match(/<g\b/g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length);
  });

  it("导入的字体写成 @font-face data URI", () => {
    const { store, pageId } = withPage();
    const text = createNode("text", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 100,
      text: "Aa",
      style: { fontFamily: "Brand Sans" },
    });
    store.apply({ type: "node.create", params: { nodes: [text], parentId: pageId } });
    const svg = render(store.doc, {}, [
      { family: "Brand Sans", weight: 400, style: "normal", mime: "font/woff2", bytes: new Uint8Array([1, 2, 3]) },
    ] as never[]);
    expect(svg).toContain("@font-face");
    expect(svg).toContain("data:font/woff2;base64,");
  });
});

describe("SvgBackend：图片、效果、蒙版", () => {
  it("图片按 href 内嵌，并按裁切区域定位", () => {
    const { store, pageId } = withPage();
    const image = createNode("image", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      image: { assetId: "a1", naturalWidth: 200, naturalHeight: 200 },
    });
    store.apply({ type: "node.create", params: { nodes: [image], parentId: pageId } });
    const resolved: ResolvedImage = {
      source: null as unknown as CanvasImageSource,
      width: 200,
      height: 200,
      href: "data:image/png;base64,AAAA",
    };
    const svg = render(store.doc, { resolveImage: () => resolved });
    expect(svg).toContain("<image");
    expect(svg).toContain('href="data:image/png;base64,AAAA"');
    // 整图裁切后按节点尺寸摆放
    expect(svg).toContain('width="100"');
    expect(svg).toContain('height="100"');
  });

  it("投影生成 feDropShadow，内阴影生成合成链", () => {
    const { store, pageId } = withPage();
    const rect = createNode("rect", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      style: {
        effects: [
          { type: "drop-shadow", visible: true, x: 0, y: 4, blur: 8, spread: 0, color: { value: "#000000" } },
          { type: "inner-shadow", visible: true, x: 0, y: 2, blur: 4, spread: 0, color: { value: "#111111" } },
        ],
      },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const svg = render(store.doc);
    expect(svg).toContain("<filter");
    expect(svg).toContain("feDropShadow");
    expect(svg).toContain("feComposite");
    expect(svg).toContain("feMerge");
  });

  it("蒙版节点遮住后一位兄弟，输出 mask", () => {
    const { store, pageId } = withPage();
    const mask = createNode("ellipse", { parentId: pageId, x: 0, y: 0, width: 50, height: 50, isMask: true });
    const target = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 100, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [mask], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [target], parentId: pageId } });
    const svg = render(store.doc);
    expect(svg).toContain("<mask");
    expect(svg).toContain('mask-type:alpha');
    expect(svg).toContain('mask="url(#mask0)"');
  });

  it("栅格化兜底贴回世界坐标：用当前矩阵的逆变换", () => {
    const { store, pageId } = withPage();
    const frame = createNode("frame", { parentId: pageId, x: 100, y: 100, width: 200, height: 200 });
    const child = createNode("rect", { parentId: frame.id, x: 10, y: 10, width: 50, height: 50 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [child], parentId: frame.id } });
    const fallback = new Map([[child.id, { href: "data:image/png;base64,BBBB", rect: { x: 110, y: 110, width: 50, height: 50 } }]]);
    const svg = render(store.doc, { rasterFallback: fallback as never });
    expect(svg).toContain("data:image/png;base64,BBBB");
    expect(svg).toContain("matrix(");
  });
});

describe("SvgBackend：阴影扩散与容器模糊", () => {
  it("投影 spread > 0：只膨胀阴影轮廓，原始 SourceGraphic 叠回最上层", () => {
    const { store, pageId } = withPage();
    const rect = createNode("rect", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      style: {
        effects: [{ type: "drop-shadow", visible: true, x: 0, y: 4, blur: 8, spread: 12, color: { value: "#000" } }],
      },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const svg = render(store.doc);
    expect(svg).toContain('feMorphology in="s0s" operator="dilate" radius="12"');
    // 源图必须在阴影之上，且没有被膨胀（feDropShadow 的旧写法会把元素本身放大）
    expect(svg).toContain('<feMerge result="s0"><feMergeNode in="s0b"/><feMergeNode in="SourceGraphic"/></feMerge>');
    expect(svg).not.toContain("<feDropShadow");
  });

  it("投影 spread < 0 用 erode", () => {
    const { store, pageId } = withPage();
    const rect = createNode("rect", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      style: {
        effects: [{ type: "drop-shadow", visible: true, x: 0, y: 2, blur: 4, spread: -8, color: { value: "#000" } }],
      },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    expect(render(store.doc)).toContain('operator="erode" radius="8"');
  });

  it("内阴影 spread 参与扩散，偏移读形态学结果", () => {
    const { store, pageId } = withPage();
    const rect = createNode("rect", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      style: {
        effects: [{ type: "inner-shadow", visible: true, x: 0, y: 2, blur: 4, spread: 6, color: { value: "#111" } }],
      },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const svg = render(store.doc);
    expect(svg).toContain('feMorphology in="SourceAlpha" operator="dilate" radius="6" result="i0s"');
    expect(svg).toContain('feOffset in="i0s"');
  });

  it("没有扩散时不插形态学节点", () => {
    const { store, pageId } = withPage();
    const rect = createNode("rect", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      style: {
        effects: [
          { type: "drop-shadow", visible: true, x: 0, y: 4, blur: 8, spread: 0, color: { value: "#000" } },
          { type: "inner-shadow", visible: true, x: 0, y: 2, blur: 4, spread: 0, color: { value: "#111" } },
        ],
      },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    expect(render(store.doc)).not.toContain("feMorphology");
  });

  it("容器上的图层模糊同样裁到自身轮廓（与 canvas 的 shapeMask 一致）", () => {
    const { store, pageId } = withPage();
    const frame = createNode("frame", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      style: { effects: [{ type: "layer-blur", visible: true, radius: 8 }] },
    });
    const child = createNode("rect", { parentId: frame.id, x: 10, y: 10, width: 20, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [child], parentId: frame.id } });
    const svg = render(store.doc);
    expect(svg).toMatch(/<g clip-path="url\(#clip\d+\)"><g filter="url\(#fx\d+\)">/);
  });
});

describe("SvgBackend：两端对齐", () => {
  it("同段换行时，非末行按词拆成 tspan 逐词定位", () => {
    const { store, pageId } = withPage();
    const text = createNode("text", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 200,
      text: "a b c d e f g h i j k l m n o p q r s t",
      textAutoResize: "auto-height",
      style: { fontSize: 16, textAlign: "justify", fill: { value: "#111" } },
    });
    store.apply({ type: "node.create", params: { nodes: [text], parentId: pageId } });
    expect(render(store.doc)).toContain("<tspan");
  });
});

describe("SvgBackend：渐变", () => {
  it("线性渐变写进 defs，填充引用 url(#id)", () => {
    const { store, pageId } = withPage();
    const rect = createNode("rect", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      style: {
        fill: {
          type: "linear",
          from: { x: 0, y: 0.5 },
          to: { x: 1, y: 0.5 },
          stops: [
            { offset: 0, color: { value: "#000000" } },
            { offset: 1, color: { value: "#ffffff" } },
          ],
        },
      },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const svg = render(store.doc);
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain('gradientUnits="objectBoundingBox"');
    expect(svg).toContain('x1="0" y1="0.5" x2="1" y2="0.5"');
    expect(svg).toContain('stop-color="#000000"');
    expect(svg).toContain('stop-color="#ffffff"');
    expect(svg).toContain('fill="url(#g0)"');
  });

  it("径向渐变带半径与焦点", () => {
    const { store, pageId } = withPage();
    const rect = createNode("rect", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      style: {
        fill: {
          type: "radial",
          from: { x: 0.5, y: 0.5 },
          to: { x: 1, y: 0.5 },
          focus: { x: 0.4, y: 0.4 },
          stops: [
            { offset: 0, color: { value: "#111111" } },
            { offset: 1, color: { value: "#222222" } },
          ],
        },
      },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const svg = render(store.doc);
    expect(svg).toContain("<radialGradient");
    expect(svg).toContain('r="0.5"');
    expect(svg).toContain('fx="0.4" fy="0.4"');
  });

  it("angular / diamond 在 SVG 里退回第一个 stop（宿主会先栅格化该节点）", () => {
    const { store, pageId } = withPage();
    const rect = createNode("rect", {
      parentId: pageId,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      style: {
        fill: {
          type: "angular",
          from: { x: 0.5, y: 0.5 },
          to: { x: 1, y: 0.5 },
          stops: [
            { offset: 0, color: { value: "#abcdef" } },
            { offset: 1, color: { value: "#ffffff" } },
          ],
        },
      },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const svg = render(store.doc);
    expect(svg).toContain('fill="#abcdef"');
    expect(svg).not.toContain("<linearGradient");
  });
});
