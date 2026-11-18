/**
 * 内置示例的统一入口：欢迎页与 ⌘K 都从这里打开。
 */
import { openGeneratedDocument } from "../file-session";
import type { DocState } from "@sqraft/core";
import { buildLoginExample } from "./login";
import { buildCardGridExample } from "./cards";
import { buildUmbraExample } from "./umbra";

export type ExampleId = "login" | "cards" | "umbra";

export function buildExample(id: ExampleId): { title: string; state: DocState } {
  switch (id) {
    case "login":
      return buildLoginExample();
    case "cards":
      return buildCardGridExample();
    case "umbra":
      return buildUmbraExample();
  }
}

export async function openExample(id: ExampleId): Promise<boolean> {
  const { title, state } = buildExample(id);
  return openGeneratedDocument(title, state);
}
