/**
 * 执行器的公共类型：宿主能力、工具上下文、分派签名。
 */
import type { DocNode, DocStore, MeasureText, NodeId, NodeStyle } from "@sqraft/core";

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

/** 截图区域（文档坐标）；省略表示整个视口。 */
export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 文档级操作由宿主提供：工具层不直接碰文件系统与窗口。 */
export interface DocumentHost {
  /** 返回是否真的新建了；用户在"保存 / 不保存 / 取消"里选取消时返回 false。 */
  newDocument(): Promise<boolean>;
  /**
   * 应用元信息（只读）：版本来自主进程 `app.getVersion()`，平台由宿主注入。
   * 宿主不提供时 `app_info` 明确报错，而不是编一个版本号。
   */
  appInfo?(): { name: string; version: string; platform: string } | Promise<{ name: string; version: string; platform: string }>;
  /**
   * 把 base64 位图落进资源仓库，返回 assetId 与原图尺寸。
   * 只收数据、不收路径——工具层不允许读任意文件。
   */
  addImage?(data: string, mimeType: string): Promise<{ assetId: string; width: number; height: number }>;
  /** 返回是否真的打开了文件；用户取消返回 false。 */
  openDocument(): Promise<boolean>;
  /** 切到某个页面：create_page 后让「省略 parentId」的后续操作落到新页 */
  activatePage?(pageId: NodeId): void;
  /** 按倍率渲染 PNG data URL（由宿主注入，工具层不碰 DOM；允许先解码图片再返回） */
  exportPng?(request: { pageId: NodeId; nodeIds?: NodeId[]; scale: number }): string | Promise<string>;
  /** 导入字体（字节内联，不收路径），返回字族/字重/风格 */
  importFont?(fileName: string, dataBase64: string): Promise<{ family: string; weight: number; style: string } | null>;
}

/** 执行器向外提供的宿主能力（由渲染层注入；工具层不碰文件系统与 DOM）。 */
export interface ToolContext {
  store: DocStore;
  getScreenshot: (region?: ScreenshotRegion) => Promise<string>;
  getActivePageId?: () => NodeId | null;
  /** 宿主注入的文本测量：建/改文本节点时用 */
  measureText?: (node: DocNode, style: NodeStyle, text: string) => { width: number; height: number };
  host?: DocumentHost;
  getSelection?: () => NodeId[];
  defaultName?: (kind: "page" | "component") => string;
  /** 诊断用的逐行字体宽度；不传则跳过 TEXT_OVERFLOW */
  measureLine?: MeasureText;
}

export type Handler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<string>;

/** 执行器的可选注入：以后加参数只动这里，不再拉长位置参数表。 */
export interface ExecutorOptions {
  /** 诊断用的逐行字体宽度（core 不碰 canvas）；不传则跳过 TEXT_OVERFLOW */
  measureLine?: MeasureText;
}
