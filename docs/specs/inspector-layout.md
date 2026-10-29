# 检查器、自动布局与文本排版

状态：已定稿（本轮实现）

## 目标

检查器按 Figma 对齐补齐可设置项，并让每个控件真实生效；同时把自动布局、文本排版、旋转、锁定、多选批量编辑接入现有命令系统。

## 总原则

- 一切文档变更仍走 `DocStore.apply(Command)`；命令确定性不变。
- `packages/core` 不依赖 DOM/Canvas；文本测量在 UI 层完成后以尺寸提交。
- 渲染只经 `RenderBackend`；选中框/插槽高亮/参考线属于 UI 叠加层。

## 模型

### NodeStyle

| 字段 | 类型 | 说明 |
|---|---|---|
| `cornerRadius` | `{ topLeft, topRight, bottomRight, bottomLeft }` | 四角独立 |
| `lineHeight` + `lineHeightUnit` | number / `auto \| px \| percent` | `auto` 用 `TEXT_LINE_HEIGHT` |
| `letterSpacing` + `letterSpacingUnit` | number / `px \| percent` | percent 以字号为基准 |
| `paragraphSpacing` | number | 段落间距（px） |
| `textAlign` | `left \| center \| right \| justify` | |
| `textVerticalAlign` | `top \| middle \| bottom` | fixed 高度生效 |
| `textCase` | `none \| upper \| lower \| title` | |
| `textDecoration` | `none \| underline \| strikethrough` | |
| `fontStyle` | `normal \| italic` | |

### LayoutSpec

```ts
interface Padding { top: number; right: number; bottom: number; left: number }
interface LayoutSpec {
  direction: "horizontal" | "vertical";
  gap: number;
  padding: Padding;
  mainAlign: "start" | "center" | "end" | "space-between";
  crossAlign: "start" | "center" | "end" | "stretch";
  wrap: boolean;
  crossGap: number;
  alignContent: "start" | "center" | "end" | "space-between" | "stretch";
}
```

### DocNode

| 字段 | 类型 | 说明 |
|---|---|---|
| `opacity` | number 0–1 | 默认 1，按层叠生效 |
| `clip` | boolean | 仅 frame/component；新节点 true，迁移旧文档 false |
| `layoutSizingW/H` | `fixed \| hug \| fill` | 子项在父布局中的尺寸行为 |
| `layoutMinW/H`、`layoutMaxW/H` | number | fill/fixed 的夹紧 |
| `layoutAbsolute` | boolean | 退出排布，X/Y 相对容器左上角 |
| `textAutoResize` | `auto-width \| auto-height \| fixed` | 仅文本 |
| `listType` | `none \| bulleted \| numbered` | 仅文本 |
| `truncate` | boolean | fixed 高度下省略号截断 |

## 自动布局

- 仅 frame/component 可拥有 `layout`；实例继承并可逐字段覆盖，不能增删。
- **新建** frame/component 默认开启布局：纵向、gap 10、四边 padding 10、尺寸 fixed（旧文档与转换来的组件不套默认值）。检查器保留“移除布局”，移除后子项保持当前几何。
- 容器可 Fixed/Hug；`Fill` 仅作为布局容器的子项出现；hug 轴上子项 fill 退化为 fixed；group 恒 hug（只读）。
- 交叉轴 `stretch` 只拉伸 `fixed` / `fill` 子项；`hug` 与文本自动尺寸保持内容尺寸，避免与测量写回互相覆盖。
- 隐藏子项退出排布；锁定子项仍参与排布。
- 事务末尾自底向上求解一次，几何写回与用户命令同一撤销条目；派生几何不记录为覆盖。
- 布局容器内拖拽子项 = 重排；⌘ 拖动 = 转绝对定位；手柄/检查器改尺寸 = 自动转 fixed。
- 绝对定位 X/Y 相对容器左上角，忽略 padding。

## 文本

- 整段单一样式，不做 runs。
- 受控字体栈：Geist / Geist Mono / 系统无衬线 / 系统衬线 / 系统等宽；字重 100–900；斜体。
- auto width / auto height / fixed 三模式；W/H 编辑切 fixed。
- 行内编辑使用 contenteditable，与画布共用同一套排版 CSS 与行盒算法。
- Canvas 2D 能力子集：不做自定义 OpenType feature 与可变字体轴。

## 交互与外观

- 旋转：命中逆旋转，选中框按旋转绘制；`worldRect` 仍是轴对齐包围盒。
- 锁定：整棵子树，命令入口拒绝修改，系统同步/布局/撤销豁免。
- 多选：批量改共有字段；几何仅单选。
- 颜色：Token（color）+ 自定义 hex（8 位含 alpha）+ 无；AI 工具仍只接受 Token。
- 裁剪：按圆角边界，命中同样受限。

## 兼容

`manifest.formatVersion` 升到 2；core 提供 `migrateDoc(state, fromVersion)`，缺版本按 1 处理；旧文档 `clip` 写 false 以保持外观。

## 范围外

多填充/渐变/图片、描边对齐/虚线、混合模式/效果、字体导入/可变轴、自定义 OpenType feature、逐字 runs、布尔运算、协作。
