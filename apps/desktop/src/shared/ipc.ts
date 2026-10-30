/**
 * 主进程与渲染层之间的唯一契约：通道名 + 请求/响应形状。
 * preload 按这里的类型实现 `window.sqraft`，渲染层只依赖 `SqraftApi`。
 */

export interface OpenedFile {
  path: string;
  name: string;
  mtimeMs: number;
  bytes: Uint8Array;
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
  electron: string;
  chrome: string;
  dataPath: string;
}

export interface McpSetupInfo {
  cliPath: string;
  installed: boolean;
  installedPath: string | null;
  targetDir: string;
  /** Claude Code：`claude mcp add …` */
  commandLine: string;
  /** OpenCode V2：`opencode mcp add …` */
  opencodeCommand: string;
  /** Claude Desktop / 通用 `mcpServers` 形状 */
  json: string;
  /** OpenCode V2 形状（`mcp.servers`） */
  opencodeJson: string;
}

/** 一条 agent 连接：只读展示用（身份、连接时间、最近一次工具调用）。 */
export interface McpClientInfo {
  id: string;
  /** 身份标签，如 `c1 claude(8123)` */
  label: string;
  connectedAt: number;
  lastToolAt?: number;
  lastTool?: string;
}

export interface McpStatus {
  /** 服务是否在监听（端口占用等原因启动失败时为 false） */
  listening: boolean;
  /** 已连接的 agent 客户端（数量 = 列表长度） */
  clients: McpClientInfo[];
}

export interface McpInstallResult {
  ok: boolean;
  message: string;
  info: McpSetupInfo;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallRequest {
  id: number;
  name: string;
  args: Record<string, unknown>;
}

export interface McpCallResult {
  id: number;
  ok: boolean;
  value?: string;
  error?: string;
}

export interface CloseRequest {
  /** true 表示这次是退出应用，false 只是关闭窗口 */
  quit: boolean;
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
    /** 接入配置（路径由主进程计算） */
    setup(): Promise<McpSetupInfo>;
    installCli(): Promise<McpInstallResult>;
  };
  recent: {
    list(): Promise<{ path: string; name: string }[]>;
  };
  menu: {
    /** 菜单点击 → 与快捷键相同的动作 id */
    onCommand(handler: (action: string) => void): () => void;
    /** 把当前键位同步给主进程，用于菜单里的快捷键提示 */
    setBindings(bindings: Record<string, string>): void;
  };
  app: {
    info(): Promise<AppInfo>;
    /** 写系统剪贴板（渲染层不需要剪贴板权限） */
    copyText(text: string): void;
    /**
     * 读剪贴板里的图片字节（没有图返回 null）；渲染层拿不到剪贴板权限。
     * 不返回 mime：真实格式由渲染层按 magic bytes 判定（扩展名/声明都不可信）。
     */
    readClipboardImage(): Promise<Uint8Array | null>;
    /** 把 PNG data URL 写进系统剪贴板（复制为图片） */
    writeClipboardImage(dataUrl: string): Promise<boolean>;
    /** 把节点载荷写进系统剪贴板的 sqraft 自定义 MIME（JSON 字符串） */
    writeClipboardNodes(json: string): Promise<void>;
    /** 读节点载荷；剪贴板里没有 sqraft 数据时返回 null */
    readClipboardNodes(): Promise<string | null>;
    /** 读剪贴板纯文本（输入框里的粘贴用它，因为 ⌘V 的菜单 role 会让位） */
    readClipboardText(): Promise<string>;
    /** 主进程要求"跳过欢迎页直接建空稿"（MCP 自动拉起） */
    onNewDocumentRequest(handler: () => void): () => void;
    /** 渲染层装好监听后通知主进程：可以补发积压的打开请求了 */
    signalReady(): void;
    /** 主进程请求打开某个文件（recent / 拖拽 / 文件关联 / 第二实例） */
    onOpenRequest(handler: (path: string) => void): () => void;
    /** 让主进程显示"已修改"标记并记住脏状态 */
    setDirty(dirty: boolean, name: string): void;
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
  mcpInstallCli: "mcp:install-cli",
  appCopyText: "app:copy-text",
  appClipboardImage: "app:clipboard-image",
  appClipboardText: "app:clipboard-text",
  appClipboardImageWrite: "app:clipboard-image-write",
  appClipboardNodesWrite: "app:clipboard-nodes-write",
  appClipboardNodesRead: "app:clipboard-nodes-read",
  appInfo: "app:info",
  appNewDocument: "app:new-document",
  recentList: "recent:list",
  menuCommand: "menu:command",
  menuSetBindings: "menu:set-bindings",
  appRendererReady: "app:renderer-ready",
  appSetDirty: "app:set-dirty",
  appRequestClose: "app:request-close",
  appFinishClose: "app:finish-close",
  appCancelClose: "app:cancel-close",
} as const;
