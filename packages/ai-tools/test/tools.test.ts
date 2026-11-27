import { describe, expect, it } from "vitest";
import { requiresTabId, toMCPManifest, tools } from "../src";

/**
 * 工具清单的 `tabId` 契约。
 *
 * `tabId` 由 `tools.ts` 统一注入，桌面宿主在分派前校验它等于当前活动标签；
 * 这里锁住"哪些工具带、排在哪个位置"，防止新增工具或改白名单时静默漏掉。
 */

const TAB_FREE = new Set(["app_info", "app_state"]);

describe("工具清单的目标标签契约", () => {
  it("除 app_info / app_state 外，每个工具都有 tabId 且排在 required 首位", () => {
    for (const tool of tools) {
      const schema = tool.input_schema as { properties?: Record<string, unknown>; required?: string[] };
      if (TAB_FREE.has(tool.name)) {
        expect(schema.properties?.tabId, tool.name).toBeUndefined();
        continue;
      }
      expect(schema.properties?.tabId, tool.name).toBeDefined();
      expect(schema.required?.[0], tool.name).toBe("tabId");
    }
  });

  it("MCP 清单与工具数组同源，同样带 tabId", () => {
    const manifest = toMCPManifest();
    expect(manifest.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    const create = manifest.find((tool) => tool.name === "create_node");
    expect(create).toBeDefined();
    const schema = create!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties?.tabId).toBeDefined();
    expect(schema.required?.[0]).toBe("tabId");
  });

  it("requiresTabId 只对文档类工具为真，未知工具为假", () => {
    expect(requiresTabId("read_document")).toBe(true);
    expect(requiresTabId("create_node")).toBe(true);
    expect(requiresTabId("screenshot")).toBe(true);
    expect(requiresTabId("app_state")).toBe(false);
    expect(requiresTabId("app_info")).toBe(false);
    // 未知工具交给执行器报「未知工具」，不要在参数校验之前被拦成缺 tabId
    expect(requiresTabId("nope")).toBe(false);
  });
});
