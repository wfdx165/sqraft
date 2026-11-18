/**
 * 多倍率导出的输出计划（纯函数，便于单测）：
 * PNG 倍率去重、只留 1/2/4、升序，末尾按需追加一份 SVG。
 */
export const MATRIX_SCALES = [1, 2, 4] as const;

export interface MatrixItem {
  format: "png" | "svg";
  /** 仅 PNG 有意义；SVG 固定为 1 */
  scale: number;
}

export function matrixPlan(settings: { scales: readonly number[]; includeSvg: boolean }): MatrixItem[] {
  const scales = [...new Set(settings.scales)]
    .filter((scale): scale is 1 | 2 | 4 => (MATRIX_SCALES as readonly number[]).includes(scale))
    .sort((a, b) => a - b);
  const items: MatrixItem[] = scales.map((scale) => ({ format: "png", scale }));
  if (settings.includeSvg) items.push({ format: "svg", scale: 1 });
  return items;
}
