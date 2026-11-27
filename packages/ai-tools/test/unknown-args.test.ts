import { describe, expect, it } from "vitest";
import { call, setup } from "./helpers";

/**
 * 未知参数不再静默成功。
 *
 * 历史问题：`update_node` 收到 `style: {...}` 时 handler 只挑认识的键，其余丢掉，
 * 返回 `{"ok":true}` 但画布没动。执行器现在按工具 `input_schema` 在分派前拦下。
 */
describe("AI 工具：未知参数", () => {
  it("update_node 传 style 直接报错，点名键与可用参数", async () => {
    const { store, run } = setup();
    const rect = await call(run, "create_node", { kind: "rect", width: 10, height: 10 });
    const id = rect.nodeId as string;
    const before = JSON.stringify(store.doc);

    await expect(
      run("update_node", { nodeId: id, style: { fill: "#ff0000" } }),
    ).rejects.toThrow(/"style".*可用参数：.*nodeId/);
    expect(JSON.stringify(store.doc)).toBe(before);
    // 拒绝发生在事务之前：撤销一次仍然撤掉 create_node，而不是一个空的 update
    store.undo();
    expect(store.doc.nodes[id]).toBeUndefined();
  });

  it("只读工具同样校验（read_document 的 bogus）", async () => {
    const { run } = setup();
    await expect(run("read_document", { scope: "page", bogus: true })).rejects.toThrow(
      /read_document: 未知参数 "bogus"/,
    );
  });

  it("嵌套结构带路径：create_nodes 的 nodes[0].style", async () => {
    const { run } = setup();
    await expect(
      run("create_nodes", { nodes: [{ id: "a", kind: "rect", style: { fill: "#fff" } }] }),
    ).rejects.toThrow(/create_nodes: 未知参数 "nodes\[0\]\.style"/);
  });

  it("oneOf 分支按最匹配的一条报错：effects[0] 的未知键", async () => {
    const { run, store } = setup();
    const rect = await call(run, "create_node", { kind: "rect" });
    await expect(
      run("update_node", {
        nodeId: rect.nodeId,
        effects: [{ type: "drop-shadow", color: "#1a1a1a", foo: 1 }],
      }),
    ).rejects.toThrow(/未知参数 "effects\[0\]\.foo"/);
    expect(store.doc.nodes[rect.nodeId as string].style.effects).toBeUndefined();
  });

  it("oneOf 的另一种形状同样校验：cornerRadius 对象的未知键", async () => {
    const { run } = setup();
    const rect = await call(run, "create_node", { kind: "rect" });
    await expect(
      run("update_node", { nodeId: rect.nodeId, cornerRadius: { topLeft: 4, foo: 8 } }),
    ).rejects.toThrow(/未知参数 "cornerRadius\.foo"/);
    // number 分支不受影响
    await expect(
      call(run, "update_node", { nodeId: rect.nodeId, cornerRadius: 6 }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("schema 没写 additionalProperties 的层级保持宽松", async () => {
    const { store, run } = setup();
    const rect = await call(run, "create_node", { kind: "rect" });
    await expect(
      call(run, "update_node", {
        nodeId: rect.nodeId,
        fillGradient: {
          type: "linear",
          from: { x: 0, y: 0.5, note: "自由形状，schema 未声明键" },
          to: { x: 1, y: 0.5 },
          stops: [
            { offset: 0, color: { value: "#ffffff" } },
            { offset: 1, color: { value: "#000000" } },
          ],
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.doc.nodes[rect.nodeId as string].style.fill).toBeTruthy();
  });

  it("合法参数不受影响，效果的字面量颜色可用", async () => {
    const { store, run } = setup();
    const rect = await call(run, "create_node", { kind: "rect" });
    await call(run, "update_node", {
      nodeId: rect.nodeId,
      fill: "#3366ff",
      effects: [{ type: "drop-shadow", x: 0, y: 6, blur: 18, color: "#1a1a1a" }],
    });
    const node = store.doc.nodes[rect.nodeId as string];
    expect(node.style.fill).toEqual({ value: "#3366ff" });
    expect(node.style.effects?.[0]).toMatchObject({ type: "drop-shadow", color: { value: "#1a1a1a" } });
  });

  it("本来就不接受参数的工具（app_state）收到任何键都报错", async () => {
    const { run } = setup();
    await expect(run("app_state", { tab: "t1" })).rejects.toThrow(
      /app_state: 未知参数 "tab"（该层不接受任何参数）/,
    );
  });
});
