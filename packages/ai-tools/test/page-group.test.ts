import { describe, expect, it } from "vitest";
import { call, setup } from "./helpers";

describe("MCP 页面分组工具与按组读写", () => {
  it("创建分组、组内建页继承默认尺寸、read_document 与 search_nodes 支持 groupId", async () => {
    const { run, pageId } = setup();

    // 在默认页建一个按钮
    await call(run, "create_node", { parentId: pageId, kind: "rect", name: "LoginButton" });

    // 创建 iPad 分组（带默认尺寸）
    const created = await call(run, "create_page_group", {
      name: "iPad",
      defaultPageSize: { width: 1024, height: 1366 },
    });
    expect(created.ok).toBe(true);
    const groupId = String(created.groupId);

    // 在 iPad 分组内建页，应继承 1024×1366
    const ipadPage = await call(run, "create_page", { name: "iPad Home", groupId });
    expect(ipadPage.groupId).toBe(groupId);
    const ipadPageId = String(ipadPage.pageId);
    await call(run, "create_node", { parentId: ipadPageId, kind: "rect", name: "LoginButton" });

    // read_document(scope="document") 带 pageGroups 摘要，且支持 groupId 过滤
    const docAll = await call(run, "read_document", { scope: "document" });
    expect((docAll.pageGroups as Array<{ groupId: string }>).map((g) => g.groupId)).toEqual([groupId]);
    expect((docAll.pages as unknown[]).length).toBe(2);

    const docGroup = await call(run, "read_document", { scope: "document", groupId });
    expect((docGroup.pages as Array<{ pageId: string; width: number; height: number }>)).toEqual([
      expect.objectContaining({ pageId: ipadPageId, width: 1024, height: 1366, groupId }),
    ]);

    // search_nodes 按 groupId 隔离搜索
    const hits = await call(run, "search_nodes", { name: "LoginButton", groupId });
    expect((hits.hits as Array<{ rootId: string }>).map((h) => h.rootId)).toEqual([ipadPageId]);

    // 隐藏分组后，默认搜索跳过该组页面；includeHidden=true 时可见
    await call(run, "update_page_group", { groupId, visible: false });
    const hitsAfterHide = await call(run, "search_nodes", { name: "LoginButton" });
    expect((hitsAfterHide.hits as Array<{ rootId: string }>).map((h) => h.rootId)).toEqual([pageId]);
    const hitsWithHidden = await call(run, "search_nodes", { name: "LoginButton", includeHidden: true });
    expect((hitsWithHidden.hits as unknown[]).length).toBe(2);

    // assign_pages_to_group 与 delete_page_group
    await call(run, "assign_pages_to_group", { pageIds: [pageId], groupId });
    const deleted = await call(run, "delete_page_group", { groupId, mode: "ungroup" });
    expect(deleted.ok).toBe(true);
    const docAfterDelete = await call(run, "read_document", { scope: "document" });
    expect(docAfterDelete.pageGroups).toBeUndefined();
    expect((docAfterDelete.pages as unknown[]).length).toBe(2);
  });
});
