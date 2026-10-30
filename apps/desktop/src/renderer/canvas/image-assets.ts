/**
 * 收集一次渲染会用到的图片资源：图片节点 + 页面背景图。
 *
 * 导出（`renderPngAsync`）与 MCP 截图（`getScreenshot`）共用：
 * 两者都得先把位图解码好，再交给同步的 `drawDocument`，否则会画成占位灰叉。
 */
import { subtreeWorldBounds, walkSubtree, worldRect, type DocNode, type DocState, type NodeId, type Rect } from "@sqraft/core";

export interface ImageAssetQuery {
  /** 只取这些子树（导出选区） */
  nodeIds?: readonly NodeId[];
  /** 只取这一页（页面导出） */
  pageId?: NodeId;
  /** 只取与这个区域相交的图片（截图 / 视口裁剪） */
  region?: Rect;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 收集本次渲染会用到的 assetId（去重，顺序不稳定）。 */
export function imageAssetIds(doc: DocState, query: ImageAssetQuery = {}): string[] {
  const ids = new Set<string>();
  const region = query.region;

  const overlaps = (rect: Rect | null): boolean => !region || Boolean(rect && intersects(rect, region));

  const visit = (node: DocNode): void => {
    if (node.visible === false) return;
    if (node.type !== "image" || !node.image?.assetId) return;
    if (region) {
      // 用子树包围盒：旋转/效果外扩后仍可能与截图区域相交
      if (!overlaps(subtreeWorldBounds(doc, node.id))) return;
    }
    ids.add(node.image.assetId);
  };

  const addPage = (page: DocNode): void => {
    const background = page.backgroundImage?.assetId;
    if (background && overlaps(worldRect(doc, page.id))) ids.add(background);
    for (const childId of page.children) walkSubtree(doc, childId, visit);
  };

  if (query.nodeIds?.length) {
    for (const id of query.nodeIds) {
      const node = doc.nodes[id];
      if (!node) continue;
      if (node.type === "page") addPage(node);
      else walkSubtree(doc, id, visit);
    }
  } else if (query.pageId) {
    const page = doc.nodes[query.pageId];
    if (page) addPage(page);
  } else {
    for (const id of doc.rootIds) {
      const page = doc.nodes[id];
      if (page) addPage(page);
    }
  }
  return [...ids];
}
