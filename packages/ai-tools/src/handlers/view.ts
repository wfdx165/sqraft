// 工具名直接分派；每个分支保持原实现，ctx 提供 store 与宿主能力。
import type { DocNode, NodeId, Rect, ScreenshotRegion } from "../shared";
import { diagnose, firstPageId, getPages, isGradientPaint, resolvePaint, round2, worldRect } from "../shared";
import type { Handler } from "../types";

/** `export_as`：导出成数据（不写剪贴板、不写盘）。 */
export const handleExportAs: Handler = async (ctx, args) => {
    if (!ctx.host?.exportImage) throw new Error("当前宿主不支持导出");
    const pageId = (args.pageId as NodeId | undefined) ?? ctx.getActivePageId?.() ?? firstPageId(ctx.store.doc);
    if (!pageId || !ctx.store.doc.nodes[pageId]) throw new Error("pageId 不存在");
    const nodeIds = Array.isArray(args.nodeIds) ? (args.nodeIds as NodeId[]) : undefined;
    const format = args.format === "svg" ? "svg" : "png";
    const scale = typeof args.scale === "number" ? args.scale : 2;
    if (format === "png" && ![1, 2, 4].includes(scale)) throw new Error("scale 只能是 1、2 或 4");
    const result = await ctx.host.exportImage({ format, pageId, nodeIds, scale });
    const payload = format === "svg" ? result.svg : result.image;
    if (!payload) throw new Error("导出失败：没有可导出的内容");
    const MAX_BYTES = 4 * 1024 * 1024;
    if (payloadBytes(format, payload) > MAX_BYTES) {
        throw new Error("导出结果超过 4MB，请缩小选区或降低倍率");
    }
    const size = format === "svg" ? svgSize(payload) : pngSize(payload);
    return JSON.stringify({
      ok: true,
      format,
      ...(format === "svg" ? { svg: payload } : { image: payload }),
      ...size,
      ...(result.rasterized?.length ? { rasterized: result.rasterized } : {}),
    });
};

/** 结果体积按**字节**算：SVG 是文本（UTF-8），PNG 是 base64 文本。 */
function payloadBytes(format: "png" | "svg", payload: string): number {
    if (format === "svg") return new TextEncoder().encode(payload).length;
    const comma = payload.indexOf(",");
    if (comma < 0) return payload.length;
    // base64 每 4 个字符还原 3 字节（含 padding 时略微高估，上限判断足够了）
    return Math.ceil(((payload.length - comma - 1) * 3) / 4);
}

/** SVG 根上的宽高（导出时按文档单位写死）。 */
function svgSize(svg: string): { width: number; height: number } {
    const w = /<svg[^>]*\bwidth="([\d.]+)"/.exec(svg);
    const h = /<svg[^>]*\bheight="([\d.]+)"/.exec(svg);
    return { width: w ? Number(w[1]) : 0, height: h ? Number(h[1]) : 0 };
}

/** PNG data URL 的像素尺寸（IHDR 在文件头）。 */
function pngSize(dataUrl: string): { width: number; height: number } {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return { width: 0, height: 0 };
    const binary = atob(dataUrl.slice(comma + 1, comma + 1 + 32));
    if (binary.length < 24) return { width: 0, height: 0 };
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** `import_svg`：只收源码，不读磁盘；失败时给出可执行的建议。 */
export const handleImportSvg: Handler = async (ctx, args) => {
    if (!ctx.host?.importSvg) throw new Error("当前宿主不支持导入 SVG");
    const svg = typeof args.svg === "string" ? args.svg : "";
    if (!svg.trim()) throw new Error("svg 不能为空");
    if (new TextEncoder().encode(svg).length > 5 * 1024 * 1024) {
      throw new Error("SVG 源码超过 5MB，请先精简，或用 create_node 的 image 参数传入位图");
    }
    const pageId = (args.pageId as NodeId | undefined) ?? ctx.getActivePageId?.() ?? firstPageId(ctx.store.doc);
    if (!pageId || !ctx.store.doc.nodes[pageId]) throw new Error("pageId 不存在");
    const x = typeof args.x === "number" ? args.x : undefined;
    const y = typeof args.y === "number" ? args.y : undefined;
    const result = await ctx.host.importSvg({ svg, pageId, x, y });
    if (!result) throw new Error("导入失败：SVG 含无法栅格化的结构，请先用 create_node 的 image 参数传入位图");
    return JSON.stringify({
      ok: true,
      frameId: result.frameId,
      width: result.width,
      height: result.height,
      ...(result.rasterized.length ? { rasterized: result.rasterized } : {}),
      ...(result.missingFonts.length ? { missingFonts: result.missingFonts } : {}),
    });
};

/** `screenshot` */
export const handleScreenshot: Handler = async (ctx, args) => {
    const region = args.region as ScreenshotRegion | undefined;
    if (region) {
      const valid =
        Number.isFinite(region.x) &&
        Number.isFinite(region.y) &&
        Number.isFinite(region.width) &&
        Number.isFinite(region.height) &&
        region.width > 0 &&
        region.height > 0;
      if (!valid) throw new Error("screenshot.region 需要 x/y/width/height，且宽高为正数");
    }
    const format = args.format === undefined ? "image" : String(args.format);
    if (format !== "image" && format !== "text") {
      throw new Error('screenshot.format 只能是 "image" 或 "text"');
    }
    if (format === "image") {
      return JSON.stringify({ ok: true, image: await ctx.getScreenshot(region) });
    }
    // 文本替代视图：看不见图的客户端用几何 + 解析后的颜色自检
    let area = region;
    if (!area) {
      const activePage = ctx.getActivePageId?.() ?? firstPageId(ctx.store.doc);
      const page = activePage ? ctx.store.doc.nodes[activePage] : null;
      const box = page ? worldRect(ctx.store.doc, page.id) : null;
      if (!box) throw new Error("当前文档没有页面，无法确定截图区域");
      area = { x: box.x, y: box.y, width: box.width, height: box.height };
    }
    const areaBox: Rect = { x: area.x, y: area.y, width: area.width, height: area.height };
    const MAX_TEXT_NODES = 200;
    /** 渐变没法压成一个色值：给类型与解析后的色标，避免 agent 把渐变读成"无填充"。 */
    const gradientSummary = (paint: DocNode["style"]["fill"]) => {
      if (!isGradientPaint(paint)) return undefined;
      return {
        type: paint.type,
        stops: paint.stops.map((stop) => ({
          offset: stop.offset,
          color: resolvePaint(ctx.store.doc, stop.color) ?? null,
        })),
      };
    };
    const rows: Array<Record<string, unknown>> = [];
    const included = new Set<NodeId>();
    let textTruncated = false;
    const visit = (id: NodeId): void => {
      if (textTruncated) return;
      const node: DocNode | undefined = ctx.store.doc.nodes[id];
      if (!node || !node.visible) return;
      const box = worldRect(ctx.store.doc, id);
      if (!box) return;
      const hits = !(
        box.x + box.width < areaBox.x ||
        areaBox.x + areaBox.width < box.x ||
        box.y + box.height < areaBox.y ||
        areaBox.y + areaBox.height < box.y
      );
      if (hits && node.type !== "page") {
        if (rows.length >= MAX_TEXT_NODES) {
          textTruncated = true;
          return;
        }
        rows.push({
          id: node.id,
          name: node.name,
          type: node.type,
          parentId: node.parentId,
          x: round2(box.x),
          y: round2(box.y),
          width: node.width,
          height: node.height,
          visible: node.visible,
          opacity: node.opacity,
          fill: resolvePaint(ctx.store.doc, node.style.fill) ?? null,
          stroke: resolvePaint(ctx.store.doc, node.style.stroke) ?? null,
          ...(gradientSummary(node.style.fill) ? { fillGradient: gradientSummary(node.style.fill) } : {}),
          ...(gradientSummary(node.style.stroke) ? { strokeGradient: gradientSummary(node.style.stroke) } : {}),
          text: node.type === "text" ? (node.text ?? "") : null,
        });
        included.add(node.id);
      }
      for (const child of node.children) visit(child);
    };
    for (const page of getPages(ctx.store.doc)) visit(page.id);
    // 诊断只看最外层被纳入的节点，避免同一问题按祖先重复计数
    const roots = [...included].filter((id) => {
      const parentId = ctx.store.doc.nodes[id]?.parentId ?? null;
      return !parentId || !included.has(parentId);
    });
    const diag = diagnose(ctx.store.doc, roots, { measure: ctx.measureLine, maxNodes: 2000, maxDiagnostics: 20 });
    return JSON.stringify({
      ok: true,
      format: "text",
      region: { x: round2(areaBox.x), y: round2(areaBox.y), width: round2(areaBox.width), height: round2(areaBox.height) },
      nodes: rows,
      truncated: textTruncated,
      ...(diag.diagnostics.length ? { diagnostics: diag.diagnostics } : {}),
      ...(diag.truncated ? { diagnosticsTruncated: true } : {}),
      hint: 'Text view: geometry plus resolved colors. Call with format:"image" when the client can read images.',
    });
};
