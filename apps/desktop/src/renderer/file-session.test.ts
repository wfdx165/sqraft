import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDoc, createNode, firstPageId } from "@sqraft/core";
import type { UnsavedChoice } from "../shared/ipc";

// file-session 在模块顶层读 window.sqraft，所以先装一个最小桥，再动态导入
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
    onCloseRequest: () => () => {},
    finishClose: vi.fn(),
    cancelClose: vi.fn(),
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
});
