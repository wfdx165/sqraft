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

const { fileState, installFileSession, newDocument, saveDocument } = await import("./file-session");
const { docStore, ui } = await import("./store");

/** 造一份有未保存改动的文档，返回新加节点的 id。 */
function makeDirtyDocument(): string {
  docStore.replace(createEmptyDoc());
  ui.docOpen = true;
  // 空稿没有页面：先建一页（根节点只放页面与主组件）
  const page = createNode("page", { name: "页面 1", width: 200, height: 200 });
  docStore.apply({ type: "node.create", params: { nodes: [page], parentId: null } });
  const pageId = firstPageId(docStore.doc)!;
  const rect = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 10, height: 10 });
  docStore.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
  return rect.id;
}

describe("新建文档的未保存检查", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docStore.replace(createEmptyDoc());
    ui.docOpen = false;
  });

  it("有改动时先问，取消则当前文档原样保留", async () => {
    const nodeId = makeDirtyDocument();
    bridge.dialog.unsaved.mockResolvedValueOnce("cancel");

    await expect(newDocument()).resolves.toBe(false);
    expect(bridge.dialog.unsaved).toHaveBeenCalledTimes(1);
    expect(docStore.doc.nodes[nodeId]).toBeDefined();
    expect(ui.docOpen).toBe(true);
  });

  it("有改动时选不保存才替换成空稿", async () => {
    const nodeId = makeDirtyDocument();
    bridge.dialog.unsaved.mockResolvedValueOnce("discard");

    await expect(newDocument()).resolves.toBe(true);
    expect(docStore.doc.nodes[nodeId]).toBeUndefined();
    expect(ui.docOpen).toBe(true);
  });

  it("有改动时选保存：保存失败（取消另存为）则放弃新建", async () => {
    makeDirtyDocument();
    bridge.dialog.unsaved.mockResolvedValueOnce("save");
    bridge.file.saveAs.mockResolvedValueOnce({ status: "canceled" });

    await expect(newDocument()).resolves.toBe(false);
    expect(ui.docOpen).toBe(true);
  });

  it("没有改动时不打扰用户", async () => {
    await expect(newDocument()).resolves.toBe(true);
    expect(bridge.dialog.unsaved).not.toHaveBeenCalled();
    expect(ui.docOpen).toBe(true);
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
    docStore.replace(createEmptyDoc());
    ui.docOpen = false;
    fileState.path = null;
    fileState.dirty = false;
    installFileSession();
  });

  it("编辑后变脏，保存成功后立刻变干净", async () => {
    makeDirtyDocument();
    expect(fileState.dirty).toBe(true);
    expect(bridge.app.setDirty).toHaveBeenLastCalledWith(true, "未命名");

    fileState.path = "/tmp/测试.sqraft";
    fileState.mtimeMs = 0;
    await expect(saveDocument()).resolves.toBe(true);
    expect(fileState.dirty).toBe(false);
    expect(bridge.app.setDirty).toHaveBeenLastCalledWith(false, "未命名");
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

  it("新建文档后回到干净状态", async () => {
    makeDirtyDocument();
    expect(fileState.dirty).toBe(true);
    bridge.dialog.unsaved.mockResolvedValueOnce("discard");
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
    docStore.replace(createEmptyDoc());
    ui.docOpen = false;
    fileState.path = "/tmp/并发.sqraft";
    fileState.mtimeMs = 0;
    installFileSession();
  });

  afterEach(() => {
    fileState.path = null;
    fileState.mtimeMs = 0;
  });

  it("进行中再次触发：复用同一次保存，只落盘一次、不弹冲突框", async () => {
    makeDirtyDocument();
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
 * 曾经的事故：文档里混进不可克隆的值（Vue 代理）→ `structuredClone` 抛错 →
 * 保存静默失败；关闭流程里 `saveDocument()` 抛错 → 既不 finishClose 也不 cancelClose →
 * 主进程的挂起永久不解除，之后所有关闭请求都被丢弃。
 */
describe("保存失败必须可见", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docStore.replace(createEmptyDoc());
    ui.docOpen = false;
    fileState.path = "/tmp/测试.sqraft";
    fileState.mtimeMs = 0;
    installFileSession();
  });

  /** 造一个无法 JSON 序列化的文档（循环引用），模拟"保存抛出"而不是"返回 false"。 */
  function poisonDocument(): void {
    const nodeId = makeDirtyDocument();
    (docStore.doc.nodes[nodeId] as unknown as { self: unknown }).self = docStore.doc.nodes[nodeId];
  }

  it("序列化抛错时报错并返回 false，不会悄悄吞掉", async () => {
    poisonDocument();
    await expect(saveDocument()).resolves.toBe(false);
    expect(bridge.dialog.error).toHaveBeenCalledWith(expect.stringContaining("保存失败"));
  });

  it("关闭时保存失败也要解除主进程的挂起，否则窗口永远关不掉", async () => {
    poisonDocument();
    bridge.dialog.unsaved.mockResolvedValueOnce("save");

    await closeHandler?.({ quit: false });

    expect(bridge.app.finishClose).not.toHaveBeenCalled();
    expect(bridge.app.cancelClose).toHaveBeenCalledTimes(1);
  });
});
