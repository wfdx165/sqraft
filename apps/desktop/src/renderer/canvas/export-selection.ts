/**
 * 选区（或活动页）的导出动作：复制到剪贴板 / 存成文件。
 *
 * 取景与 PNG 共用 `exportBounds`：有选区导选区（透明底），没选区导当前页（带页面背景）。
 * 入口是右键 Copy as 与文件菜单 Export as，两边都落到这里。
 */
import { firstPageId, type DocNode, type NodeId } from "@sqraft/core";
import type { ExportSettings } from "../../shared/ipc";
import { fileState } from "../file-session";
import { exportFileName, exportMatrixObjectName, exportObjectName } from "../export-name";
import { t } from "../i18n";
import { logInfo, logWarn } from "../log";
import { docStore, ui } from "../store";
import { showToast } from "../toast";
import { matrixPlan } from "./export-matrix";
import { buildExportZip, type ExportZipEntry } from "./export-zip";
import { renderPngAsync, type ExportRequest } from "./export-image";
import { renderSvgAsync } from "./svg-export";
import { imageFor, ensureAssetDecoded } from "../assets";
import { linkedImage, ensureLinkedImage } from "../linked-images";

export type ExportFormat = "png" | "svg";

interface Target {
  pageId: NodeId | null;
  nodeIds: NodeId[] | undefined;
}

/** 节点所在页面（选区可能不在活动页上）。 */
function pageOf(nodeId: NodeId): NodeId | null {
  let cur: DocNode | undefined = docStore.doc.nodes[nodeId];
  while (cur) {
    if (cur.type === "page") return cur.id;
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  return null;
}

/** 选区优先；选中页面时等于整页。 */
export function exportTarget(): Target {
  const nodeIds = ui.selection.filter((id) => {
    const node = docStore.doc.nodes[id];
    return !!node && node.type !== "page";
  });
  const selectionPage = nodeIds.length ? pageOf(nodeIds[0]) : null;
  const pageId = selectionPage ?? ui.activePageId ?? firstPageId(docStore.doc);
  return { pageId, nodeIds: nodeIds.length ? nodeIds : undefined };
}

function requestOf(target: Target, scale: number): ExportRequest {
  return {
    pageId: target.pageId ?? undefined,
    nodeIds: target.nodeIds,
    scale,
    resolveImage: (assetId) => imageFor(assetId),
    resolveLinkedImage: (url) => linkedImage(url),
    ensureImage: ensureAssetDecoded,
    ensureLinkedImage,
  };
}

function tooLarge(scale: number): boolean {
  return scale >= 4;
}

/** data URL → 原始字节（PNG 导出落盘用）。 */
function decodeDataUrl(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 复制：PNG 走位图剪贴板，SVG 走纯文本。 */
export async function copySelectionAs(format: ExportFormat, scale: number): Promise<void> {
  const target = exportTarget();
  if (!target.pageId) {
    showToast(t("canvas.copyNoPage"), "error");
    return;
  }
  try {
    await document.fonts.ready;
    if (format === "svg") {
      const { svg, rasterized } = await renderSvgAsync(docStore.doc, requestOf(target, 1));
      if (!svg) {
        showToast(t("canvas.copyEmpty"), "error");
        return;
      }
      window.sqraft.app.copyText(svg);
      showToast(
        rasterized.length ? t("canvas.copiedRaster", { count: rasterized.length }) : t("canvas.copiedSvg"),
        "info",
      );
      if (rasterized.length) logInfo("export/svg rasterized", { nodes: rasterized.join(", ") });
      return;
    }

    const dataUrl = await renderPngAsync(docStore.doc, requestOf(target, scale));
    if (!dataUrl) {
      // 4× 撞上画布像素护栏时 renderPng 返回空串：告诉用户换个倍率，别只说「内容为空」
      showToast(
        tooLarge(scale) ? t("canvas.exportTooLarge") : t("canvas.copyEmpty"),
        "error",
      );
      return;
    }
    const ok = await window.sqraft.app.writeClipboardImage(dataUrl);
    showToast(ok ? t("canvas.copiedPng") : t("canvas.copyClipboardUnavailable"), ok ? "info" : "error");
  } catch (error) {
    showToast(t("canvas.copyFailed", { detail: String(error) }), "error");
  }
}

/** 存盘：点哪一项就是哪一项，直接弹保存框，不再问格式。 */
export async function exportSelectionAs(format: ExportFormat, scale: number): Promise<void> {
  const target = exportTarget();
  if (!target.pageId) {
    showToast(t("canvas.copyNoPage"), "error");
    return;
  }
  try {
    await document.fonts.ready;
    const objectName = exportObjectName(docStore.doc, target);
    if (format === "svg") {
      const { svg, rasterized } = await renderSvgAsync(docStore.doc, requestOf(target, 1));
      if (!svg) {
        showToast(t("canvas.copyEmpty"), "error");
        return;
      }
      const bytes = new TextEncoder().encode(svg);
      const result = await window.sqraft.file.exportFile({
        suggestedName: exportFileName(fileState.name, objectName, "svg"),
        bytes,
        format: "svg",
      });
      if (result.status === "error") {
        showToast(result.message, "error");
        return;
      }
      // 取消不提示；真的写盘了才说栅格化了多少节点
      if (result.status === "ok" && rasterized.length) {
        logInfo("export/svg rasterized", { nodes: rasterized.join(", ") });
        showToast(t("canvas.exportedRaster", { count: rasterized.length }), "info");
      }
      return;
    }

    const dataUrl = await renderPngAsync(docStore.doc, requestOf(target, scale));
    if (!dataUrl) {
      showToast(tooLarge(scale) ? t("canvas.exportTooLarge") : t("canvas.copyEmpty"), "error");
      return;
    }
    const bytes = decodeDataUrl(dataUrl);
    const result = await window.sqraft.file.exportFile({
      suggestedName: exportFileName(fileState.name, objectName, "png", scale),
      bytes,
      format: "png",
    });
    if (result.status === "error") showToast(result.message, "error");
  } catch (error) {
    logWarn("export failed", { error: String(error) });
    showToast(t("canvas.copyFailed", { detail: String(error) }), "error");
  }
}

/**
 * 多倍率导出：渲染勾选的全部输出，打成一个 ZIP 交给主进程选一次保存位置。
 * 任一输出渲染失败就整批中止（不写出半套文件）。
 */
export async function exportSelectionMatrix(settings: ExportSettings): Promise<"ok" | "canceled" | "error"> {
  const target = exportTarget();
  if (!target.pageId) {
    showToast(t("canvas.copyNoPage"), "error");
    return "error";
  }
  const plan = matrixPlan(settings);
  if (plan.length === 0) {
    showToast(t("exportMatrix.empty"), "error");
    return "error";
  }
  try {
    await document.fonts.ready;
    // 多倍率导出统一用「页面名-对象名」，包名与包内文件同一套前缀
    const objectName = exportMatrixObjectName(docStore.doc, target);
    const entries: ExportZipEntry[] = [];
    for (const item of plan) {
      if (item.format === "svg") {
        const { svg, rasterized } = await renderSvgAsync(docStore.doc, requestOf(target, 1));
        if (!svg) {
          showToast(t("canvas.copyEmpty"), "error");
          return "error";
        }
        if (rasterized.length) logInfo("export/svg rasterized", { nodes: rasterized.join(", ") });
        entries.push({
          name: exportFileName(fileState.name, objectName, "svg"),
          bytes: new TextEncoder().encode(svg),
          format: "svg",
        });
        continue;
      }
      const dataUrl = await renderPngAsync(docStore.doc, requestOf(target, item.scale));
      if (!dataUrl) {
        showToast(t("canvas.exportTooLarge"), "error");
        return "error";
      }
      entries.push({
        name: exportFileName(fileState.name, objectName, "png", item.scale),
        bytes: decodeDataUrl(dataUrl),
        format: "png",
      });
    }

    // 把实际导出的组合回写给偏好：对话框下次打开就是这次的选择
    const effective: ExportSettings = {
      scales: plan.filter((item) => item.format === "png").map((item) => item.scale),
      includeSvg: plan.some((item) => item.format === "svg"),
    };
    const result = await window.sqraft.file.exportMatrix({
      suggestedName: exportFileName(fileState.name, objectName, "zip"),
      bytes: buildExportZip(entries),
      count: entries.length,
      settings: effective,
    });
    if (result.status === "canceled") return "canceled";
    if (result.status === "error") {
      showToast(result.message, "error");
      return "error";
    }
    showToast(t("canvas.exportedZip", { name: result.name, count: result.count }), "info");
    return "ok";
  } catch (error) {
    logWarn("export matrix failed", { error: String(error) });
    showToast(t("canvas.copyFailed", { detail: String(error) }), "error");
    return "error";
  }
}
