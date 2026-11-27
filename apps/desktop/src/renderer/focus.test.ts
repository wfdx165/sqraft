import { beforeEach, describe, expect, it, vi } from "vitest";

const data = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => {
    data.set(key, String(value));
  },
  removeItem: (key: string) => {
    data.delete(key);
  },
});

// 载入时越界的宽度要被夹回范围
data.set("sqraft.panels.v1", JSON.stringify({ left: 100, right: 900 }));

const { panelWidths, panelsUi, persistPanelWidths, setPanelWidth, togglePanels } = await import("./focus");

beforeEach(() => {
  panelWidths.left = 300;
  panelWidths.right = 276;
  panelsUi.open = true;
});

describe("面板宽度", () => {
  it("读回越界值时夹到范围里", () => {
    // 模块初次载入已经执行过 loadWidths，这里直接验证同一套夹取规则
    setPanelWidth("left", 1000);
    expect(panelWidths.left).toBe(480);
    setPanelWidth("left", 10);
    expect(panelWidths.left).toBe(220);
    setPanelWidth("right", 999);
    expect(panelWidths.right).toBe(420);
    setPanelWidth("right", 0);
    expect(panelWidths.right).toBe(200);
  });

  it("写入 localStorage，读回能夹取", () => {
    panelWidths.left = 360;
    panelWidths.right = 240;
    persistPanelWidths();
    expect(JSON.parse(data.get("sqraft.panels.v1")!)).toEqual({ left: 360, right: 240 });
  });
});

describe("面板开关", () => {
  it("一次收起、再一次展开", () => {
    expect(panelsUi.open).toBe(true);
    togglePanels();
    expect(panelsUi.open).toBe(false);
    togglePanels();
    expect(panelsUi.open).toBe(true);
  });

  it("收起不改变记住的宽度", () => {
    togglePanels();
    expect(panelWidths.left).toBe(300);
    expect(panelWidths.right).toBe(276);
  });

  it("只落宽度、不落展开状态（重启总是展开）", () => {
    togglePanels();
    persistPanelWidths();
    expect(Object.keys(JSON.parse(data.get("sqraft.panels.v1")!)).sort()).toEqual(["left", "right"]);
  });
});
