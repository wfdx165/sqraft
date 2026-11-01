# ADR-0028：数值 Token 支持节点引用（字号 / 间距 / 圆角等）

> 数值 Token 早就能建（`define_token type=number`），但节点没有任何字段能引用它：
> 字号、行高、间距、圆角只能存字面量，agent 想"按设计系统批量绑定"会被卡住。
> 本 ADR 把数值引用补进模型，并用**读时解析**保持与颜色 Token 相同的语义。

## Context

- `TokenEntry` 支持 `type: "color" | "number"`，但 `NodeStyle` / `LayoutSpec` 里只有 `fill` / `stroke`
  能带 `.token`；`GLOSSARY.md` 早已把"间距、字号、圆角"写进 Token 的职责，实现没跟上。
- 颜色 Token 的既有约定是"节点存引用、渲染前解析"（`docs/architecture.md` §8），没有把值写回节点。
- 数值 Token 会参与布局与文本测量：改一个 `spacing/md` 就要重排、改字号要重新量文本。
  如果采用"把值同步进字面量"的做法，撤销（只重放逆命令、不跑派生 pass）、锁定节点、
  实例覆盖都会变复杂。
- 用户要求：字号 / 行高 / 字距 / 段距 / 描边宽 / 圆角 / 间距 / 内边距**全部**支持，
  且圆角按角、内边距按边**独立**绑定；检查器要有 Token 选择器，不只给 AI 用。

## Decision

- **15 个可绑定槽位**：
  - `NodeStyle`：`fontSizeToken`、`lineHeightToken`、`letterSpacingToken`、`paragraphSpacingToken`、
    `strokeWidthToken`；
  - `NodeStyle.cornerRadiusTokens: { topLeft?, topRight?, bottomRight?, bottomLeft? }`（逐角）；
  - `LayoutSpec`：`gapToken`、`crossGapToken`；
  - `LayoutSpec.paddingTokens: { top?, right?, bottom?, left? }`（逐边）。
- **读时解析**（`packages/core/src/token-resolve.ts`）：
  `resolveNumericStyle` / `resolveNumericLayout` 在渲染、布局求解、文本测量、检查器展示时调用；
  Token 有效则覆盖对应字面量，缺失或类型不对**回退字面量**。没有引用时返回原对象（画布热路径零分配）。
- **范围约定**：字号必须为正，圆角/间距/内边距夹到 `>= 0`，行高 `>= 0`；字距允许负值。
- **改值即重算**：`token.define`（number）把引用该路径的节点标脏；布局 pass 重新求解，
  渲染层收到 `__doc__` 标记后对 auto-width / auto-height 文本做一次全量测量。
- **改名 / 删除**：`rename_token` 同步改 `style` / `layout` 与实例覆盖表里的数值引用；
  `delete_token(detach=true)` 把每个引用冻结成**当前解析值**再清引用（逐角/逐边只冻结该角/该边）。
- **检查器**：每个数值输入旁加 Token 按钮（`TokenLink`），点开 `TokenPicker`（只列数值 Token）；
  统一圆角/内边距的按钮一次绑四角/四边，分角/分边各自独立。手改字面量即解绑对应槽位。
- **MCP**：`create_node` / `update_node` 接受上述字段；`cornerRadiusTokens` / `paddingTokens` 支持
  `null` 解绑单项；数值 Token 做存在性与类型校验（颜色 Token 塞进数值字段直接报错）。

## Considered Options

- **把 Token 值同步进字面量（materialize）**：渲染和布局不用改，但 Token 改值要批量改节点，
  撤销、锁定节点、实例覆盖都要额外处理，且两份真源容易漂移。否决。
- **只做 AI 绑定、检查器只读**：改动更小，但用户明确要求"检查器一起做"，否决。
- **圆角/内边距只支持统一值**：实现简单，但用户要求逐角/逐边独立。否决。
- **把数值字段直接改成 `number | string`**：schema 与所有读取方都要做联合类型判断，破坏面大。否决。

## Consequences

- 文件格式版本 6 → 7；新增字段全部可选，旧文件无需迁移。
- 绑定的数值**不参与缩放工具**（Token 优先，缩放只写字面量）；与颜色 Token 的"改 Token 全局生效"一致。
- 锁定节点的 Token 改值仍会生效（锁定限制编辑，不限制 Token 解析），与颜色 Token 相同。
- 改数值 Token 会触发一次布局重算与全量文本测量；属于设计系统级操作，频率低，可接受。
- 实例覆盖表里的数值引用必须和颜色引用走同一套改名/删除测试，否则组件同步会把旧路径写回。
- 跨文档复制粘贴会把节点引用的数值 Token 定义一起带进剪贴板载荷（`tokenPathsOfNode`），因此粘贴端不会因为缺 Token 回退成旧字面量。
- 暂不支持：效果参数（模糊/偏移/扩散）、宽高尺寸、坐标、字重、每项单独单位；
  需要时按同一模式扩展。
