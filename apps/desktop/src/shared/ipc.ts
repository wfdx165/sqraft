/**
 * 主进程与渲染层之间的唯一契约：通道名 + 请求/响应形状。
 * preload 按这里的类型实现 `window.sqraft`，渲染层只依赖 `SqraftApi`。
 */
import type { LanguagePreference, Locale } from "./i18n";

export interface OpenedFile {
  path: string;
  name: string;
  mtimeMs: number;
  /** 文件字节数 */
  size: number;
  /**
   * 一次性取件地址（`sqraft-doc://file/<token>`）：渲染层 `fetch` 它流式拿到文件内容。
   * 不经 IPC 整块传字节——上 GB 的文档结构化克隆要好几秒。只能取一次，60 秒内有效。
   */
  url: string;
}

export type OpenFileResult =
  | { status: "canceled" }
  | { status: "ok"; file: OpenedFile }
  | { status: "error"; message: string };

export interface SaveFileRequest {
  path: string;
  bytes: Uint8Array;
  /** 上次读/写时记录的磁盘时间戳；不一致说明文件被外部改过。 */
  expectedMtimeMs: number | null;
}

export type SaveFileResult =
  | { status: "ok"; mtimeMs: number }
  | { status: "conflict"; mtimeMs: number }
  | { status: "error"; message: string };

export interface SaveAsRequest {
  suggestedName: string;
  bytes: Uint8Array;
}

export type SaveAsResult =
  | { status: "canceled" }
  | { status: "ok"; path: string; name: string; mtimeMs: number }
  | { status: "error"; message: string };

/** 关闭前询问：保存 / 不保存 / 取消 */
export type UnsavedChoice = "save" | "discard" | "cancel";
/** 外部修改后的保存冲突：覆盖 / 另存为 / 取消 */
export type OverwriteChoice = "overwrite" | "save-as" | "cancel";

export interface AppInfo {
  name: string;
  version: string;
  dataPath: string;
  language: LanguagePreference;
  locale: Locale;
}

/** 语言偏好的当前解析结果。 */
export interface LanguageState {
  language: LanguagePreference;
  locale: Locale;
}

export interface McpSetupInfo {
  /** 当前端点（服务没起来时是按偏好算出来的地址） */
  url: string;
  /** 实际监听端口；没起来时为 null */
  port: number | null;
  /** 用户显式指定的端口；null = 自动模式（7331 起，被占向上顺延） */
  explicitPort: number | null;
  /** 自动模式下因端口被占而顺延：原来想用的端口；没漂移时为 null */
  driftFrom: number | null;
  listening: boolean;
  /** 启动失败原因（端口被占、权限不足等）；正常时为 null */
  error: string | null;
  /** Claude Code：`claude mcp add --transport http …` */
  commandLine: string;
  /** OpenCode V2 形状（`mcp.servers`，type = remote） */
  opencodeJson: string;
  /** Cursor / 通用 `mcpServers` 形状 */
  cursorJson: string;
}

/** 一条 agent 会话：只读展示用（身份、连接时间、最近一次工具调用）。 */
export interface McpClientInfo {
  id: string;
  /** 身份标签，如 `c1 claude-code/2.1` */
  label: string;
  connectedAt: number;
  lastToolAt?: number;
  lastTool?: string;
}

export interface McpStatus {
  /** 服务是否在监听（端口占用等原因启动失败时为 false） */
  listening: boolean;
  port: number | null;
  url: string | null;
  /** 活跃会话（数量 = 列表长度） */
  clients: McpClientInfo[];
  /** 启动失败原因 */
  error: string | null;
  /** 自动模式下发生漂移时，原来的端口 */
  driftFrom: number | null;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 主进程抓一张链接图片的结果；失败时 `reason` 直接给用户看。 */
export type FetchImageResult =
  | { ok: true; bytes: Uint8Array; contentType: string; /** 用的是上一次缓存（断网/404/超时） */ stale: boolean }
  | { ok: false; reason: string };

export interface McpCallRequest {
  id: number;
  name: string;
  args: Record<string, unknown>;
  /**
   * 发起这次调用的客户端标签（`c1 claude-code/2.1`）。
   * 只用于界面展示「谁在操作」，不参与命令、不进文档。
   */
  clientLabel?: string;
}

export interface McpCallResult {
  id: number;
  ok: boolean;
  value?: string;
  error?: string;
}

/** 渲染层上报的日志：只收事件文本与字段，主进程统一格式化。 */
export type AppLogLevel = "info" | "warn" | "error";

export interface AppLogEntry {
  level: AppLogLevel;
  event: string;
  fields?: Record<string, unknown>;
}

export interface CloseRequest {
  /** true 表示这次是退出应用，false 只是关闭窗口 */
  quit: boolean;
}

/** 更新器阶段：`dev` / `unsupported` 都不发请求。 */
export type UpdatePhase = "dev" | "unsupported" | "idle" | "checking" | "up-to-date" | "downloading" | "ready" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
  publishedAt: string | null;
  /** 下载进度 0–1；非下载阶段保留上一次值 */
  progress: number;
  /** 面向用户的状态说明（失败原因等）；没有额外信息时为 null */
  message: string | null;
  /** 进入"已就绪"的时间（毫秒）；未就绪为 null */
  readyAt: number | null;
  /** 当前安装位置是否支持自动更新 */
  supported: boolean;
}

export interface SqraftApi {
  readonly platform: string;
  file: {
    open(): Promise<OpenFileResult>;
    /** 按已知路径打开（最近列表 / 拖拽 / 双击文件 / 第二实例转发），不弹对话框 */
    openPath(path: string): Promise<OpenFileResult>;
    save(request: SaveFileRequest): Promise<SaveFileResult>;
    saveAs(request: SaveAsRequest): Promise<SaveAsResult>;
    /** 导出 PNG：弹系统保存框并落盘（bytes 是 PNG 原始字节） */
    exportPng(request: { suggestedName: string; bytes: Uint8Array }): Promise<SaveAsResult>;
  };
  dialog: {
    unsaved(): Promise<UnsavedChoice>;
    overwrite(): Promise<OverwriteChoice>;
    error(message: string): Promise<void>;
  };
  mcp: {
    /** 主进程转发来的一次工具调用（已串行化，一次只有一个在途） */
    onCall(handler: (request: McpCallRequest) => void): () => void;
    respond(result: McpCallResult): void;
    /** 渲染层是工具清单的真源（来自 @sqraft/ai-tools），启动时同步一次 */
    setTools(tools: McpToolInfo[]): void;
    /** 已连接的 agent 客户端与监听状态变化 */
    onStatus(handler: (status: McpStatus) => void): () => void;
    /** 当前状态（渲染层挂载时主动取一次：服务可能比页面先就绪） */
    status(): Promise<McpStatus>;
    /** 接入配置（地址、端口与各客户端片段） */
    setup(): Promise<McpSetupInfo>;
    /** 改端口：null = 自动（7331 起、被占顺延）；数字 = 严格使用，占用即报错 */
    setPort(port: number | null): Promise<McpSetupInfo>;
  };
  recent: {
    list(): Promise<{ path: string; name: string }[]>;
  };
  update: {
    /** 当前状态（渲染层挂载时取一次） */
    state(): Promise<UpdateState>;
    /** 检查更新；`manual` 不受 24 小时节流，失败信息会留在状态里 */
    check(manual?: boolean): Promise<UpdateState>;
    /** 重启以安装已就绪的版本：走关闭守卫（未保存时有保存/不保存/取消） */
    restart(): Promise<void>;
    /** 主进程推送的状态变化 */
    onState(handler: (state: UpdateState) => void): () => void;
  };
  menu: {
    /** 菜单点击 → 与快捷键相同的动作 id */
    onCommand(handler: (action: string) => void): () => void;
    /** 把当前键位同步给主进程，用于菜单里的快捷键提示 */
    setBindings(bindings: Record<string, string>): void;
  };
  app: {
    info(): Promise<AppInfo>;
    /** 改界面语言（auto / zh-CN / en-US / ja-JP / ko-KR），主进程持久化并广播解析结果 */
    setLanguage(preference: LanguagePreference): Promise<LanguageState>;
    /** 语言切换后的广播（已解析的 locale） */
    onLanguageChange(handler: (locale: Locale) => void): () => void;
    /** 在访达中显示随包分发的许可文本（Electron / Chromium / 第三方） */
    showLicenses(): Promise<void>;
    /** 写系统剪贴板（渲染层不需要剪贴板权限） */
    copyText(text: string): void;
    /**
     * 读剪贴板里的图片字节（没有图返回 null）；渲染层拿不到剪贴板权限。
     * 不返回 mime：真实格式由渲染层按 magic bytes 判定（扩展名/声明都不可信）。
     */
    readClipboardImage(): Promise<Uint8Array | null>;
    /**
     * 抓一张链接（远程）图片：主进程负责校验地址、限大小/超时、读写本地缓存。
     * 渲染层拿不到网络（CSP `connect-src 'self'`），只能经这里。
     * `force` = 用户点了「重新抓取」：跳过本会话的缓存直读，重新请求一次。
     */
    fetchImage(url: string, options?: { force?: boolean }): Promise<FetchImageResult>;
    /** 清空链接图片的本地缓存；返回释放的字节数 */
    clearImageCache(): Promise<{ bytes: number }>;
    /** 把 PNG data URL 写进系统剪贴板（复制为图片） */
    writeClipboardImage(dataUrl: string): Promise<boolean>;
    /** 把节点载荷写进系统剪贴板的 sqraft 自定义 MIME（JSON 字符串） */
    writeClipboardNodes(json: string): Promise<void>;
    /** 读节点载荷；剪贴板里没有 sqraft 数据时返回 null */
    readClipboardNodes(): Promise<string | null>;
    /** 读剪贴板纯文本（输入框里的粘贴用它，因为 ⌘V 的菜单 role 会让位） */
    readClipboardText(): Promise<string>;
    /** 渲染层装好监听后通知主进程：可以补发积压的打开请求了 */
    signalReady(): void;
    /** 主进程请求打开某个文件（recent / 拖拽 / 文件关联 / 第二实例） */
    onOpenRequest(handler: (path: string) => void): () => void;
    /** 让主进程显示"已修改"标记并记住脏状态 */
    setDirty(dirty: boolean, name: string): void;
    /** 渲染层日志：主进程统一格式化，写终端与平台日志目录（`app.getPath("logs")`） */
    log(level: AppLogLevel, event: string, fields?: Record<string, unknown>): void;
    /** 主进程请求关闭；渲染层处理完保存后调用 finishClose */
    onCloseRequest(handler: (request: CloseRequest) => void): () => void;
    finishClose(quit: boolean): void;
    /** 用户在"保存 / 不保存 / 取消"里选了取消：解除挂起的关闭请求 */
    cancelClose(): void;
  };
}

export const CHANNELS = {
  fileOpen: "file:open",
  fileSave: "file:save",
  fileSaveAs: "file:save-as",
  fileExportPng: "file:export-png",
  fileOpenPath: "file:open-path",
  fileOpenRequest: "file:open-request",
  fileDropped: "file:dropped",
  dialogUnsaved: "dialog:unsaved",
  dialogOverwrite: "dialog:overwrite",
  dialogError: "dialog:error",
  mcpCall: "mcp:call",
  mcpRespond: "mcp:respond",
  mcpSetTools: "mcp:set-tools",
  mcpStatus: "mcp:status",
  mcpStatusQuery: "mcp:status:query",
  mcpSetup: "mcp:setup",
  mcpSetPort: "mcp:set-port",
  appCopyText: "app:copy-text",
  appFetchImage: "app:fetch-image",
  appClearImageCache: "app:clear-image-cache",
  appClipboardImage: "app:clipboard-image",
  appClipboardText: "app:clipboard-text",
  appClipboardImageWrite: "app:clipboard-image-write",
  appClipboardNodesWrite: "app:clipboard-nodes-write",
  appClipboardNodesRead: "app:clipboard-nodes-read",
  appInfo: "app:info",
  appSetLanguage: "app:set-language",
  appLanguageChanged: "app:language-changed",
  /** 在访达里打开许可文本目录（关于面板的「开源许可」） */
  appShowLicenses: "app:show-licenses",
  recentList: "recent:list",
  updateState: "update:state",
  updateCheck: "update:check",
  updateRestart: "update:restart",
  updateChanged: "update:changed",
  menuCommand: "menu:command",
  menuSetBindings: "menu:set-bindings",
  appRendererReady: "app:renderer-ready",
  appSetDirty: "app:set-dirty",
  appLog: "app:log",
  appRequestClose: "app:request-close",
  appFinishClose: "app:finish-close",
  appCancelClose: "app:cancel-close",
} as const;
