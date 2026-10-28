# Sqraft 总体架构设计

> 术语以 [GLOSSARY.md](../GLOSSARY.md) 为准。本文描述 v1 的目标架构与各子系统契约。

## 1. 总览

Sqraft 是纯单机应用：一个 Web 应用（Vue 3 + Canvas 2D），读写本地 `.sqraft` 文件，内嵌 AI 对话面板并可作为 MCP Server 对外暴露。架构的唯一主轴是：**一切编辑都是命令，一切消费方（GUI、AI、撤销重做、持久化）都走命令层**。

```
┌─────────────────────────────────────────────────────┐
│  apps/web（Vue 3 面板层）                             │
│  工具栏 / 图层面板 / 检查器 / 对话面板（BYOK）          │
└───────────────┬─────────────────────┬───────────────┘
                │ 用户事件 → 命令        │ 工具调用
┌───────────────▼─────────────┐ ┌─────▼───────────────┐
│  packages/core（领域核心）    │ │  packages/ai-tools   │
│  文档模型 / 命令系统          │◄──┤  工具 schema（唯一真源）│
│  布局求解 / Token / 组件      │ │  对话面板与 MCP 共用   │
└───────────────┬─────────────┘ └─────────────────────┘
                │ 状态变更事件
┌───────────────▼─────────────┐
│  packages/render（渲染）      │
│  RenderBackend 接口          │
│  Canvas2D 实现 / 视口 / 命中   │
└─────────────────────────────┘
```

依赖方向自上而下单向：`web → core ← render`，`ai-tools → core` 的类型。`core` 不依赖任何 UI/渲染/浏览器 API（可在 Node 下测试）。

数据流固定为单向：

```
用户手势/AI 工具调用 → Command → DocumentStore.apply() → 变更事件
                                      ├→ 渲染器重绘
                                      ├→ 面板更新（Vue store 订阅）
                                      └→ Op Log 追加（进文件）
```

## 2. 包结构

```
packages/core/src/
├── model/        节点类型、文档结构、树不变量
├── command/      命令定义、应用器、事务、撤销栈
├── layout/       自动布局求解器（纯函数）
├── token/        Token 集合、模式、引用解析
└── component/    组件/实例、属性模型、覆盖

packages/render/src/
├── backend.ts    RenderBackend 接口
├── canvas2d.ts   Canvas 2D 实现
├── viewport.ts   平移缩放、DPR、世界↔屏幕坐标
└── hit.ts        命中检测

packages/ai-tools/src/
└── tools.ts      工具定义（JSON Schema + 执行器类型）
```

## 3. 文档模型

**扁平存储 + 树不变量**。文档是一张节点表（`Map<NodeId, Node>`），父子关系由 `parentId` / `children` 表达，满足不变量：

- 每个节点有且仅有一个父节点（页面节点除外，其父为文档）；
- 树无环；删除节点递归删除子树。

扁平表让命令（按 id 定位）与序列化（天然 JSON）都简单，也让未来协作（按节点 id 合并）有落点。

节点公共字段：`id / type / name / parentId / children / x / y / width / height / rotation / visible / locked`。坐标相对父节点内容区左上角，旋转绕自身中心。

节点类型（v1）：`page / frame / group / rect / ellipse / line / polygon / star / path / text / image / instance / component`。

**属性覆盖走同一路径**：实例对主组件的差异、文本样式、填充描边，最终都落在节点的同一属性命名空间上（见 §7/§8），避免"特殊属性系统"。

## 4. 命令系统

命令是一条 JSON 记录：`{ type, params }`。核心约束：

1. **确定性**：同一文档状态 + 同一命令 = 唯一结果。禁止命令内读时间、随机数、外部资源（资源先注册、后引用）。
2. **可逆**：每条命令实现 `invert(doc)`，得到逆命令入撤销栈。
3. **可合并**：连续手势（拖拽、调间距）走事务——`begin / update(重放) / commit`，提交时合并为一条命令写入 Op Log。

撤销栈存逆命令流；每 N 条命令做一次**检查点快照**（内存），用于快速回退与崩溃恢复。文件持久化为"快照 + 增量操作日志"（见 §10）。

AI 工具最终也落到这套命令上：**GUI 和 Agent 是同一命令层的两个前端**，这是本架构最重要的不变式。

## 5. 渲染管线

`RenderBackend` 是核心与渲染之间的唯一接口：

```ts
interface RenderBackend {
  beginFrame(viewport: Viewport): void;
  drawRect(r: RectNode, style: ResolvedStyle): void;
  drawEllipse(r: EllipseNode, style: ResolvedStyle): void;
  drawPath(d: PathData, style: ResolvedStyle): void;
  drawImage(img: CanvasImageSource, dst: Rect): void;
  drawText(layout: LaidOutText, style: ResolvedStyle): void;
  endFrame(): void;
}
```

- 绘制序 = 文档树深度优先（子在父上层），与图层面板顺序一致；
- **DPR 感知**：画布物理像素 = CSS 像素 × devicePixelRatio，视口变换矩阵统一处理平移缩放；
- v1 策略：**视口剔除 + 全视口重绘**（5k 节点预算内足够）；脏矩形与分层缓存列为撞墙后的升级项，不提前实现；
- 渲染器**无状态于文档**：每帧从 DocumentStore 拉取当前状态，杜绝渲染层缓存陈旧数据。

## 6. 自动布局求解器

纯函数：`solve(container: LayoutSpec, children: MeasuredChild[], constraints) → positions[]`。契约：

- 输入：方向、gap、padding、主/交叉轴对齐、每个子项双轴尺寸行为（hug / fill / fixed + min/max）、wrap 开关；
- 输出：子节点在容器内容区内的 `x/y/width/height`；
- 算法：**两遍法**——先测量（measure：hug 沿递归冒泡尺寸），后排布（arrange：主轴分配、交叉轴对齐）；
- **wrap 需要固定点迭代**：换行改变主轴可用空间→改变 fill 分配→可能改变行数；迭代上限 + 收敛判定防止病态输入死循环；
- 绝对定位子项不参与求解，直接按容器坐标系定位；
- 明确不做：基线对齐、CSS grid、百分比尺寸。

布局发生在命令应用之后、渲染之前，结果写回节点的 `layoutCache`（渲染直接消费，不重复计算）。

## 7. 组件系统

- 主组件（`component` 节点）定义**组件属性**：枚举（变体）、布尔、文本、实例替换；
- 实例（`instance`）记录 `componentId + 属性取值 + 覆盖`；
- 覆盖白名单（v1）：文本内容、填充/描边、可见性、嵌套实例替换；
- 组件更新 → 实例同步，覆盖保留；删除组件 → 实例转为普通 Frame（detach）。

## 8. Token 系统

- Token 按集合组织：`{ path: "color/primary", type: "color", values: { light: "#3366ff", dark: "#4477ff" } }`；
- v1 全局模式切换器（light/dark/品牌）；按画板模式覆盖留 v1.5；
- 节点样式存**Token 引用** `{ token: "color/primary" }`，渲染前解析为具体值（解析缓存按 (token, mode) 键控）；
- 导出：W3C DTCG 格式 JSON + 一键生成 CSS 变量；
- **Agent 纪律**：工具 schema 中样式参数只接受 Token 引用，字面量色值在工具层直接拒绝——这是让 AI 产出可控、可维护的核心手段。

## 9. 文本与字体

- v1 文本节点单一样式（字体族/字号/行高/字重/对齐/字色），富文本 runs 放 v1.5；
- 编辑体验用 **DOM 浮层**（textarea 覆盖文本节点，回车确认、Esc 取消）——可靠性远高于自绘光标；
- 排版：Canvas `measureText` 逐段测量 + 断行（中文按字、英文按词，遵循 CJK 禁则基础规则）；测量结果按字体参数缓存；
- 字体：系统字体直接可用；支持导入 ttf/woff2 并**嵌入文档包**（`FontFace` API 注册），保证跨机器渲染一致。

## 10. 文件格式

`.sqraft` 是一个 zip 容器：

```
manifest.json      格式版本、生成应用版本
doc.json           最近一次快照
ops.ndjson         快照之后的增量命令流
assets/            图片、嵌入字体
```

- 打开文件 = 载入快照 + 重放增量（确定性命令保证重放安全）；
- 保存时若增量超过阈值则折叠为新快照；
- `formatVersion` 单调递增，读取端只向前兼容；升级走显式迁移函数。

## 11. 存储层

- 主路径：**File System Access API**——"打开/保存"直接操作本地文件，自动保存写回已授权句柄；
- 降级路径（Safari / Firefox）：内存 + 下载导出 / 上传导入，功能等价但无自动写回；
- 浏览器不支持 File System Access 时给出明确提示与降级 UI。

## 12. AI 层

**双插槽、一套 schema**：

1. **内置对话面板**：BYOK——DeepSeek / OpenAI / Claude / 本地 Ollama；标准工具调用循环（模型 → 工具调用 → core 执行 → 结果回填 → 继续）；
2. **MCP Server**：把同一套工具定义挂到 MCP 协议上，外部 agent（Claude Code 等）可直接驱动 Sqraft。

工具清单（v1）：

| 工具 | 读/写 | 说明 |
|---|---|---|
| `read_document` | 读 | 返回页面/节点树的紧凑摘要 |
| `get_tokens` | 读 | Token 集合与当前模式取值 |
| `create_page / create_node` | 写 | 建页面/节点（样式仅接受 Token 引用） |
| `update_node` | 写 | 改属性（同上约束） |
| `delete_node / move_node` | 写 | 结构操作 |
| `set_component_property` | 写 | 组件/实例属性操作 |
| `screenshot` | 读 | 渲染指定区域为 PNG，回传给多模态模型自检 |
| `export_assets` | 读 | 导出切图，返回文件 |
| `set_prototype_link` | 写 | 页面间原型连线 |

**截图自检闭环**：agent 生成 → `screenshot` → 模型看图 → 修正命令。这是"AI 全流程"质量的下限保障。

## 13. 性能预算

- 单文件 ≤ 5,000 节点，拖拽/缩放/滚动 60fps（中端笔记本）；拉伸目标：2 万节点可浏览；
- 打开 < 2s，内存 < 500MB；
- 手势期间命令走事务高频通道，不触发 Vue 全量响应（画布状态独立于响应式系统）。

## 14. 测试策略

- **布局求解 golden 测试**：手工构造布局用例集（含 wrap、min/max 边界），快照对比位置输出——求解器是纯函数，这是最便宜的高价值测试；
- **命令确定性测试**：随机命令序列重放两次，文档状态逐字节相等；文件"快照+重放"等价性测试；
- **视觉回归**：示例文档渲染截图对比（pixelmatch 容差）；
- **工具层测试**：AI 工具 schema 校验（拒绝字面量色值等纪律）。

## 15. 已知风险

| 风险 | 等级 | 对策 |
|---|---|---|
| wrap + min/max 求解器复杂度 | 高 | M2 专项攻坚；迭代上限防死循环；golden 测试先行 |
| 中文断行/字体嵌入 | 中 | v1 限单一样式；断行先做基础规则，禁则完整版后置 |
| File System Access 兼容面 | 中 | 降级路径从 M1 就存在，不事后补 |
| 多模态截图反馈的模型差异 | 低 | 截图统一为定尺寸 PNG；工具结果结构化 |
| Canvas 2D 性能撞墙 | 低 | RenderBackend 抽象已就位，可换 WebGL2 后端不动文档模型 |
