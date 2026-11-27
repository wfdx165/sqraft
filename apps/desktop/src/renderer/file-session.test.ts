import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDoc, createNode, firstPageId } from "@sqraft/core";
import type { UnsavedChoice } from "../shared/ipc";

// file-session 在模块顶层读 window.sqraft，所以先装一个最小桥，再动态导入
let closeHandler: ((request: { quit: boolean }) => Promise<void>) | null = null;
const bridge = {
  platform: "darwin",
  file: {
    open: vi.fn(),
    openPath: vi.fn(),
    save: vi.fn(async () => ({ status: "ok", mtimeMs: 1 })),
    saveAs: vi.fn(),
    stat: vi.fn(async () => []),
  },
  dialog: {
    unsaved: vi.fn(async (): Promise<UnsavedChoice> => "cancel"),
    overwrite: vi.fn(),
    error: vi.fn(async () => {}),
  },
  mcp: {
    onCall: () => () => {},
    respond: vi.fn(),
    setTools: vi.fn(),
    setup: vi.fn(),
    onStatus: () => () => {},
  },
  recent: { list: vi.fn(async () => []) },
  menu: { onCommand: () => () => {}, setBindings: vi.fn() },
  app: {
    info: vi.fn(),
    copyText: vi.fn(),
    signalReady: vi.fn(),
    onOpenRequest: () => () => {},
    setDirty: vi.fn(),
    onCloseRequest: (handler: (request: { quit: boolean }) => Promise<void>) => {
      closeHandler = handler;
      return () => {};
    },
    finishClose: vi.fn(),
    cancelClose: vi.fn(),
    log: vi.fn(),
  },
};

vi.stubGlobal("window", { sqraft: bridge });

const { closeTabById, fileState, installFileSession, newDocument, saveDocument, saveDocumentAs } = await import("./file-session");
const { activateTab, docStore } = await import("./store");
const { MAX_DOC_TABS, createDocTab, docTabs, resetSessions, sessionState } = await import("./sessions");

/** 清掉所有文档标签并回到 Home（先切走再清，门面才会重新挂到 Home 的 store 上）。 */
function closeAllDocs(): void {
  activateTab("home");
  resetSessions();
}

/** 打开一个空文档标签并激活。 */
function openDoc(): void {
  const tab = createDocTab(createEmptyDoc());
  activateTab(tab.id);
}

/** 造一份有未保存改动的文档（先开一个新标签），返回新加节点的 id。 */
function makeDirtyDocument(): string {
  openDoc();
  return addDirtyNodes();
}

/** 往当前文档里加一页一个矩形，返回矩形 id。 */
function addDirtyNodes(): string {
  // 空稿没有页面：先建一页（根节点只放页面与主组件）
  const page = createNode("page", { name: "页面 1", width: 200, height: 200 });
  docStore.apply({ type: "node.create", params: { nodes: [page], parentId: null } });
  const pageId = firstPageId(docStore.doc)!;
  const rect = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 10, height: 10 });
  docStore.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
  return rect.id;
}

describe("新建文档开新标签", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeAllDocs();
  });

  it("新建不会顶掉当前文档，而是多一个标签并切过去", async () => {
    const nodeId = makeDirtyDocument();
    const before = sessionState.activeId;

    await expect(newDocument()).resolves.toBe(true);
    expect(sessionState.activeId).not.toBe(before);
    expect(docTabs()).toHaveLength(2);
    expect(bridge.dialog.unsaved).not.toHaveBeenCalled();
    // 旧文档还在自己的标签里，节点没丢
    const previous = docTabs().find((tab) => tab.id === before);
    expect(previous?.store.doc.nodes[nodeId]).toBeDefined();
  });

  it("到上限时返回 false 且不新增标签", async () => {
    for (let i = docTabs().length; i < MAX_DOC_TABS; i += 1) createDocTab(createEmptyDoc());
    expect(docTabs()).toHaveLength(MAX_DOC_TABS);

    await expect(newDocument()).resolves.toBe(false);
    expect(docTabs()).toHaveLength(MAX_DOC_TABS);
  });
});

/**
 * 工具栏胶囊的圆点读 `fileState.dirty`。
 * 这里的回归点是"保存后必须立刻变干净"：`docStore.markSaved()` 不 emit，
 * 如果脏标记只靠文档变更（`ui.version`）驱动，圆点会一直留到下一次编辑。
 */
describe("未保存标记跟着保存点走", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeAllDocs();
    installFileSession();
  });

  it("编辑后变脏，保存成功后立刻变干净", async () => {
    makeDirtyDocument();
    expect(fileState.dirty).toBe(true);
    expect(bridge.app.setDirty).toHaveBeenLastCalledWith({ anyDirty: true, activeName: "未命名 1", activeDirty: true });

    fileState.path = "/tmp/测试.sqraft";
    fileState.mtimeMs = 0;
    await expect(saveDocument()).resolves.toBe(true);
    expect(fileState.dirty).toBe(false);
    expect(bridge.app.setDirty).toHaveBeenLastCalledWith({ anyDirty: false, activeName: "未命名 1", activeDirty: false });
  });

  it("保存后再改又变脏，撤销回保存点重新变干净", async () => {
    const nodeId = makeDirtyDocument();
    fileState.path = "/tmp/测试.sqraft";
    fileState.mtimeMs = 0;
    await expect(saveDocument()).resolves.toBe(true);
    expect(fileState.dirty).toBe(false);

    docStore.apply({ type: "node.update", params: { nodeId, patch: { x: 8 } } });
    expect(fileState.dirty).toBe(true);

    expect(docStore.undo()).toBe(true);
    expect(fileState.dirty).toBe(false);
  });

  it("新建标签是干净状态", async () => {
    makeDirtyDocument();
    expect(fileState.dirty).toBe(true);
    await expect(newDocument()).resolves.toBe(true);
    expect(fileState.dirty).toBe(false);
  });

  it("保存链路留下可定位的日志点（来源、序列化、写盘结果、保存点）", async () => {
    makeDirtyDocument();
    fileState.path = "/tmp/日志.sqraft";
    fileState.mtimeMs = 0;

    await expect(saveDocument("action")).resolves.toBe(true);

    const events = bridge.app.log.mock.calls.map(([level, event]) => `${String(level)}:${String(event)}`);
    expect(events).toEqual(
      expect.arrayContaining([
        "info:save: start",
        "info:save: serialized",
        "info:save: result",
        "info:save: marked saved",
      ]),
    );
    // 来源必须能区分快捷键/菜单、工具栏、关窗
    const start = bridge.app.log.mock.calls.find(([, event]) => event === "save: start");
    expect(start?.[2]).toMatchObject({ source: "action" });
  });
});

/**
 * 渲染层保存互斥（`.scratch/logging/issues/02-save-race-fixes.md`）：
 * 连按 ⌘S / 关窗撞上手动保存时复用进行中的那一次——只落盘一次、不弹冲突框，
 * 且后续保存拿到的是上一次刚写盘的新 mtime（假 conflict 的根因）。
 */
describe("保存互斥", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeAllDocs();
    installFileSession();
    openDoc();
  });

  afterEach(() => {
    fileState.path = null;
    fileState.mtimeMs = 0;
  });

  it("进行中再次触发：复用同一次保存，只落盘一次、不弹冲突框", async () => {
    addDirtyNodes();
    fileState.path = "/tmp/并发.sqraft";
    fileState.mtimeMs = 0;
    let release!: (result: { status: string; mtimeMs: number }) => void;
    bridge.file.save.mockImplementationOnce(
      () => new Promise<{ status: string; mtimeMs: number }>((resolve) => { release = resolve; }),
    );

    const first = saveDocument("action");
    const second = saveDocument("action");
    // 两次拿到同一个 Promise：第二次不排队、不重复序列化
    expect(second).toBe(first);

    await vi.waitFor(() => expect(bridge.file.save).toHaveBeenCalledTimes(1));
    release({ status: "ok", mtimeMs: 42 });
    await expect(first).resolves.toBe(true);

    expect(bridge.file.save).toHaveBeenCalledTimes(1);
    expect(bridge.dialog.overwrite).not.toHaveBeenCalled();
    expect(fileState.mtimeMs).toBe(42);
    // 复用留痕：现场日志里能查到"当时被合并了"
    expect(bridge.app.log.mock.calls.some(([, event]) => event === "save: in-flight, reusing")).toBe(true);

    // 互斥在保存结束后释放：再来一次是新的保存，且用的是上一次刚写盘的 mtime
    await expect(saveDocument("action")).resolves.toBe(true);
    expect(bridge.file.save).toHaveBeenCalledTimes(2);
    const secondWrite = bridge.file.save.mock.calls[1] as unknown as [{ expectedMtimeMs: number }];
    expect(secondWrite[0]).toMatchObject({ expectedMtimeMs: 42 });
    expect(bridge.dialog.overwrite).not.toHaveBeenCalled();
  });
});

/**
 * 关闭语义（ADR-0041）：单标签问一次、保存落在被关的标签上；退出时多个脏标签只用一个聚合框。
 */
describe("关闭标签与退出", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.file.save.mockImplementation(async () => ({ status: "ok", mtimeMs: 1 }));
    bridge.dialog.unsaved.mockReset();
    bridge.dialog.unsaved.mockResolvedValue("cancel");
    closeAllDocs();
    installFileSession();
  });

  it("关闭非活动脏标签：对话框带它的名字，保存写的是它自己的文件", async () => {
    const aNode = makeDirtyDocument();
    const a = docTabs().at(-1)!;
    a.file.path = "/tmp/a.sqraft";
    a.file.name = "a.sqraft";
    makeDirtyDocument(); // B 成为活动标签
    const b = docTabs().at(-1)!;
    b.file.path = "/tmp/b.sqraft";
    b.file.name = "b.sqraft";

    bridge.dialog.unsaved.mockResolvedValueOnce("save");
    await expect(closeTabById(a.id)).resolves.toBe(true);

    expect(bridge.dialog.unsaved).toHaveBeenCalledWith(["a.sqraft"]);
    const write = bridge.file.save.mock.calls.at(-1) as unknown as [{ path: string }];
    expect(write[0].path).toBe("/tmp/a.sqraft");
    expect(docTabs().map((tab) => tab.id)).toEqual([b.id]);
    expect(sessionState.activeId).toBe(b.id);
    expect(b.store.doc.nodes[aNode]).toBeUndefined();
  });

  it("取消关闭：标签与内容都还在", async () => {
    const nodeId = makeDirtyDocument();
    const tab = docTabs().at(-1)!;
    bridge.dialog.unsaved.mockResolvedValueOnce("cancel");

    await expect(closeTabById(tab.id)).resolves.toBe(false);
    expect(docTabs()).toHaveLength(1);
    expect(docStore.doc.nodes[nodeId]).toBeDefined();
  });

  it("退出：多个脏标签只弹一个聚合框，保存全部按顺序落盘", async () => {
    const first = makeDirtyDocument();
    const a = docTabs().at(-1)!;
    a.file.path = "/tmp/a.sqraft";
    a.file.name = "a.sqraft";
    const second = makeDirtyDocument();
    const b = docTabs().at(-1)!;
    b.file.path = "/tmp/b.sqraft";
    b.file.name = "b.sqraft";

    bridge.dialog.unsaved.mockResolvedValueOnce("save");
    await closeHandler?.({ quit: true });

    expect(bridge.dialog.unsaved).toHaveBeenCalledTimes(1);
    expect(bridge.dialog.unsaved).toHaveBeenCalledWith(["a.sqraft", "b.sqraft"]);
    const paths = bridge.file.save.mock.calls.map((call) => (call as unknown as [{ path: string }])[0].path);
    expect(paths).toEqual(["/tmp/a.sqraft", "/tmp/b.sqraft"]);
    expect(bridge.app.finishClose).toHaveBeenCalledWith(true);
    expect(bridge.app.cancelClose).not.toHaveBeenCalled();
    void first;
    void second;
  });

  it("退出时选全部不保存：不写盘，直接放行", async () => {
    makeDirtyDocument();
    makeDirtyDocument();
    bridge.dialog.unsaved.mockResolvedValueOnce("discard");

    await closeHandler?.({ quit: true });

    expect(bridge.file.save).not.toHaveBeenCalled();
    expect(bridge.app.finishClose).toHaveBeenCalledWith(true);
  });

  it("退出时取消：不放行、解除挂起", async () => {
    makeDirtyDocument();
    bridge.dialog.unsaved.mockResolvedValueOnce("cancel");

    await closeHandler?.({ quit: true });

    expect(bridge.app.finishClose).not.toHaveBeenCalled();
    expect(bridge.app.cancelClose).toHaveBeenCalledTimes(1);
    expect(docTabs()).toHaveLength(1);
  });

  it("没有脏标签时不打扰用户", async () => {
    makeDirtyDocument();
    const tab = docTabs().at(-1)!;
    tab.file.path = "/tmp/clean.sqraft";
    await expect(saveDocument()).resolves.toBe(true);
    bridge.dialog.unsaved.mockClear();

    await closeHandler?.({ quit: true });

    expect(bridge.dialog.unsaved).not.toHaveBeenCalled();
    expect(bridge.app.finishClose).toHaveBeenCalledWith(true);
  });
});

/**
 * 曾经的事故：文档里混进不可克隆的值（Vue 代理）→ `structuredClone` 抛错 →
 * 保存静默失败；关闭流程里 `saveDocument()` 抛错 → 既不 finishClose 也不 cancelClose →
 * 主进程的挂起永久不解除，之后所有关闭请求都被丢弃。
 */
describe("保存失败必须可见", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeAllDocs();
    installFileSession();
  });

  /** 造一个无法 JSON 序列化的文档（循环引用），模拟"保存抛出"而不是"返回 false"。 */
  function poisonDocument(): void {
    const nodeId = makeDirtyDocument();
    (docStore.doc.nodes[nodeId] as unknown as { self: unknown }).self = docStore.doc.nodes[nodeId];
  }

  it("序列化抛错时报错并返回 false，不会悄悄吞掉", async () => {
    poisonDocument();
    fileState.path = "/tmp/测试.sqraft";
    fileState.mtimeMs = 0;
    await expect(saveDocument()).resolves.toBe(false);
    expect(bridge.dialog.error).toHaveBeenCalledWith(expect.stringContaining("保存失败"));
  });

  it("关闭时保存失败也要解除主进程的挂起，否则窗口永远关不掉", async () => {
    poisonDocument();
    fileState.path = "/tmp/测试.sqraft";
    fileState.mtimeMs = 0;
    bridge.dialog.unsaved.mockResolvedValueOnce("save");

    await closeHandler?.({ quit: false });

    expect(bridge.app.finishClose).not.toHaveBeenCalled();
    expect(bridge.app.cancelClose).toHaveBeenCalledTimes(1);
  });

  it("未命名文档另存为的默认文件名带创建时编号", async () => {
    await newDocument();
    bridge.file.saveAs.mockResolvedValueOnce({ status: "canceled" });

    await saveDocumentAs("action");

    expect(bridge.file.saveAs).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: "untitled-1.sqraft" }),
    );
  });
});
