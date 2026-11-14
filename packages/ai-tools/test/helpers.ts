import { createDocWithPage, createEmptyDoc, createNode, DocStore, firstPageId } from "@sqraft/core";
import { makeExecutor, type ToolExecutor } from "../src/index";

/** 每个用例一份干净文档 + 执行器（getActivePageId 固定为第一页）。 */
export function setup(): { store: DocStore; run: ToolExecutor; pageId: string } {
  const store = new DocStore(createDocWithPage());
  const pageId = firstPageId(store.doc)!;
  const run = makeExecutor(store, async () => "", () => pageId);
  return { store, run, pageId };
}

export async function call(run: ToolExecutor, name: string, args: Record<string, unknown> = {}) {
  return JSON.parse(await run(name, args)) as Record<string, unknown>;
}

/** 供需要自己拼执行器的用例使用 */
export { createDocWithPage, createEmptyDoc, createNode, DocStore, firstPageId, makeExecutor };
export type { ToolExecutor };
