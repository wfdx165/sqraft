import { describe, expect, it } from "vitest";
import { evaluateExpression } from "./expression";

describe("数值输入算式", () => {
  it("普通数字与单位后缀", () => {
    expect(evaluateExpression("120")).toBe(120);
    expect(evaluateExpression(" 12.5 ")).toBe(12.5);
    expect(evaluateExpression("12.5px")).toBe(12.5);
    expect(evaluateExpression("50%")).toBe(50);
    expect(evaluateExpression("-8")).toBe(-8);
  });

  it("四则运算与括号", () => {
    expect(evaluateExpression("1200/2")).toBe(600);
    expect(evaluateExpression("100+16")).toBe(116);
    expect(evaluateExpression("(10+6)*2")).toBe(32);
    expect(evaluateExpression("100 - 20*2")).toBe(60);
    expect(evaluateExpression("-(4+4)")).toBe(-8);
    expect(evaluateExpression(".5*4")).toBe(2);
  });

  it("非法输入返回 null（不抛错、不 eval）", () => {
    for (const input of ["", "  ", "abc", "10+", "(3", "3)", "1/0", "2**3", "W*2", "10px+5", "1.2.3", "--"]) {
      expect(evaluateExpression(input)).toBeNull();
    }
  });
});
