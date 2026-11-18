/**
 * 设置窗口的路由：四类设置共用一个外壳。
 *
 * - `section` 只在内存里记住，不进 preferences.json（重开应用一律从「通用」开始）；
 * - 深层链接（「配置 MCP…」、⌘/、欢迎页按钮）显式传 section，覆盖记忆位置；
 * - 同一个 section 再触发一次入口 = 关闭，保留 ⌘/ 原来的开关语义。
 */
import { reactive } from "vue";
import { paletteUi, togglePalette } from "./palette";

export type SettingsSection = "general" | "mcp" | "shortcuts" | "advanced";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["general", "mcp", "shortcuts", "advanced"];

export const settingsUi = reactive({
  open: false,
  section: "general" as SettingsSection,
});

export function openSettings(section?: SettingsSection): void {
  if (section) settingsUi.section = section;
  // 命令面板与设置都是模态：同时存在会导致 Esc 一次关两层，打开设置时先收起面板
  if (paletteUi.open) togglePalette(false);
  settingsUi.open = true;
}

export function closeSettings(): void {
  settingsUi.open = false;
}

export function toggleSettings(section: SettingsSection): void {
  if (settingsUi.open && settingsUi.section === section) closeSettings();
  else openSettings(section);
}
