/**
 * 根节点名称标签的几何常量：绘制（`labels.ts`）、命中与尺寸徽标避让（`selection-overlay.ts`）
 * 必须用同一份数字，否则标签和点击区域会错位。
 */
export const LABEL_FONT = "11px 'Geist Variable', 'PingFang SC', sans-serif";
/** chip 高度 */
export const LABEL_CHIP_HEIGHT = 20;
/** chip 顶边离节点顶边的屏幕距离 */
export const LABEL_CHIP_ABOVE = 26;
/** chip 相对节点左上角的横向偏移（沿用页面标签的历史位置） */
export const LABEL_CHIP_OFFSET_X = -6;
export const LABEL_CHIP_PAD_L = 6;
export const LABEL_CHIP_PAD_R = 8;
export const LABEL_CHIP_RADIUS = 6;
/** 夹进视口时保留的最小上边距 */
export const LABEL_CHIP_MIN_Y = 2;
export const LABEL_ICON_SIZE = 12;
export const LABEL_ICON_GAP = 5;

/** chip 宽度：左内边距 + 图标 + 间距 + 文本 + 右内边距。 */
export function labelChipWidth(textWidth: number): number {
  return LABEL_CHIP_PAD_L + LABEL_ICON_SIZE + LABEL_ICON_GAP + textWidth + LABEL_CHIP_PAD_R;
}
