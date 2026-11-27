/**
 * 标签的显示名：有文件名就用文件名，未命名用创建时分配的序号（「未命名 3」）。
 *
 * 序号在 `createDocTab` 里定死、不复用，所以同一个名字在本次运行里始终指同一个标签。
 * 标签栏、关闭/退出对话框、外部改动横幅、MCP 的 `app_state` 与 Home 拒绝文案都走这里。
 */
import { t } from "./i18n";
import type { TabSession } from "./sessions";

export function tabLabel(tab: TabSession): string {
  if (tab.file.name) return tab.file.name;
  const index = tab.file.untitledIndex;
  return index ? t("common.untitledIndexed", { n: index }) : t("common.untitled");
}
