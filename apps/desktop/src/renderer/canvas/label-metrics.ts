/**
 * 根节点名称标签的几何常量：绘制（`labels.ts`）、命中与尺寸徽标避让（`selection-overlay.ts`）
 * 必须用同一份数字，否则标签和点击区域会错位。
 *
 * 字体是函数而不是常量：切换界面语言后要换成对应 CJK 字形栈，
 * 绘制与测量都调用它才能保持同宽。
 */
export { labelFont, labelFont as LABEL_FONT } from "../font-stack";
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
/**
 * 低于这个缩放比例时不再显示根节点名称标签（选中的除外）：
 * 标签是固定屏幕尺寸，缩得越小越会互相重叠、盖住页面与母版内容。
 */
export const ROOT_LABEL_MIN_ZOOM = 0.25;

/** chip 宽度：左内边距 + 图标 + 间距 + 文本 + 右内边距。 */
export function labelChipWidth(textWidth: number): number {
  return LABEL_CHIP_PAD_L + LABEL_ICON_SIZE + LABEL_ICON_GAP + textWidth + LABEL_CHIP_PAD_R;
}
