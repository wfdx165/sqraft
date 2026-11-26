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
  /** 切到某个页面：create_page 后让「省略 parentId」的后续操作落到新页 */
  activatePage?(pageId: NodeId): void;
  /**
   * 导出成数据（由宿主注入，工具层不碰 DOM / 文件系统）：
   * png 返回 data URL，svg 返回源码；`rasterized` 是被栅格化的节点名。
   */
  exportImage?(request: {
    format: "png" | "svg";
    pageId: NodeId;
    nodeIds?: NodeId[];
    scale: number;
  }): Promise<{ image?: string; svg?: string; rasterized?: string[] }>;
  /** 导入字体（字节内联，不收路径），返回字族/字重/风格 */
  importFont?(fileName: string, dataBase64: string): Promise<{ family: string; weight: number; style: string } | null>;
  /**
   * 把 SVG 源码导入页面（不读磁盘、不访问网络）；返回新建 frame、缺字体与降级提示。
   * 整份无法导入时给失败原因，由工具层翻译成可执行文案（不返回 null，免得丢掉原因）。
   */
  importSvg?(request: {
    svg: string;
    pageId: NodeId;
    x?: number;
    y?: number;
  }): Promise<SvgImportResult>;
}

/** SVG 整份导入失败的原因：宿主原样交回，文案由工具层决定。 */
export type SvgImportFailureReason =
  | "invalid-svg"
  | "no-size"
  | "empty-content"
  | "node-limit"
  | "raster-limit";

/** 单条导入降级提示：成功导入时随结果返回（agent 与界面都据此提醒用户）。 */
export interface SvgImportWarning {
  code: "IGNORED_TAG" | "UNSUPPORTED_ELEMENT" | "MISSING_USE_TARGET" | "EMPTY_SYMBOL" | "DEPTH_LIMIT";
  /** 元素名：id 优先，否则标签名 */
  element: string;
  /** 给 agent 的英文短句（界面只显示条数，避免四语再翻一遍元素名） */
  message: string;
}

/** 失败结果：超限类带上实际上限（数字只有宿主一处真源），并保留已产生的降级提示。 */
export type SvgImportFailure =
  | { ok: false; reason: "node-limit" | "raster-limit"; limit: number; warnings?: SvgImportWarning[] }
  | { ok: false; reason: "invalid-svg" | "no-size" | "empty-content"; warnings?: SvgImportWarning[] };

export type SvgImportResult =
  | {
      ok: true;
      frameId: NodeId;
      width: number;
      height: number;
      rasterized: string[];
      missingFonts: string[];
      warnings: SvgImportWarning[];
    }
  | SvgImportFailure;

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
