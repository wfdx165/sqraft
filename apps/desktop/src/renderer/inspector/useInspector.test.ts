// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInspector } from "./useInspector";

type Holder = typeof globalThis & { __sqraftInputMemory?: boolean };

function resetInstallFlag(): void {
  delete (globalThis as Holder).__sqraftInputMemory;
}

describe("检查器的输入框原值记忆", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetInstallFlag();
  });

  it("focusin 监听只装一次（HMR 重执行模块、组件重复 setup 都不重复）", () => {
    resetInstallFlag();
    const spy = vi.spyOn(document, "addEventListener");
    useInspector();
    useInspector();
    const focusin = spy.mock.calls.filter(([type]) => type === "focusin");
    expect(focusin).toHaveLength(1);
  });

  it("第一次 focusin 记下原值，非 number 输入不记", () => {
    resetInstallFlag();
    useInspector();

    const numberInput = document.createElement("input");
    numberInput.type = "number";
    numberInput.value = "120";
    document.body.append(numberInput);
    numberInput.dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(numberInput.dataset.prev).toBe("120");

    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.value = "abc";
    document.body.append(textInput);
    textInput.dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(textInput.dataset.prev).toBeUndefined();

    numberInput.remove();
    textInput.remove();
  });
});
