import { describe, expect, it } from "vitest";
import { isMcpClientId, MCP_CLIENT_IDS } from "./mcp-clients";

describe("MCP 客户端白名单", () => {
  it("六个已知 id 全部通过", () => {
    for (const id of MCP_CLIENT_IDS) expect(isMcpClientId(id)).toBe(true);
    expect(MCP_CLIENT_IDS).toHaveLength(6);
  });

  it("未知 / 非字符串一律拒绝", () => {
    for (const value of ["", "claude", "Claude-Code", "cursor ", null, undefined, 1, {}, ["cursor"]]) {
      expect(isMcpClientId(value)).toBe(false);
    }
  });
});
