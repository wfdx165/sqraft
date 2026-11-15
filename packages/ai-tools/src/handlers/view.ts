// 工具名直接分派；每个分支保持原实现，ctx 提供 store 与宿主能力。
import type { DocNode, NodeId, Rect, ScreenshotRegion } from "../shared";
import { diagnose, firstPageId, getPages, resolvePaint, round2, worldRect } from "../shared";
import type { Handler } from "../types";

/** `export_png` */
export const handleExportPng: Handler = async (ctx, args) => {
    if (!ctx.host?.exportPng) throw new Error("当前宿主不支持导出 PNG");
    const pageId = (args.pageId as NodeId | undefined) ?? ctx.getActivePageId?.() ?? firstPageId(ctx.store.doc);
    if (!pageId || !ctx.store.doc.nodes[pageId]) throw new Error("pageId 不存在");
    const nodeIds = Array.isArray(args.nodeIds) ? (args.nodeIds as NodeId[]) : undefined;
    const scale = typeof args.scale === "number" ? args.scale : 2;
    if (!(scale > 0 && scale <= 4)) throw new Error("scale 需要在 (0, 4] 之间");
    const image = await ctx.host.exportPng({ pageId, nodeIds, scale });
    if (!image) throw new Error("导出失败：没有可导出的内容");
    return JSON.stringify({ ok: true, image });
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
