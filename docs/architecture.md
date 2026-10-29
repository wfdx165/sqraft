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

页面是 `rootIds` 中的 `page` 节点，携带 `x / y / width / height`（默认 1440×1024），可在无限画布上自由拖动；新建页面自动放到最右侧页面之右（间距 160）。画布同时渲染所有页面，子节点坐标相对父容器（页面或画板），渲染与命中检测按祖先链累加偏移。

节点公共字段：`id / type / name / parentId / children / x / y / width / height / rotation / opacity / visible / locked / clip`。坐标相对父节点内容区左上角，旋转绕自身中心；`clip` 只对画板/组件/实例生效。

自动布局相关字段（子项侧）：`layoutSizingW/H`（fixed / hug / fill）、`layoutMinW/H`、`layoutMaxW/H`、`layoutAbsolute`。文本节点另有 `textAutoResize`（auto-width / auto-height / fixed）、`listType`、`truncate`。

节点类型（v1）：`page / frame / group / rect / ellipse / line / polygon / star / path / text / image / instance / component / slot`。

**参数化多边形**：`polygon` 节点持有可选的 `sides`（3–12，默认 3），顶点由包围盒推导——包围盒就是形状的外接矩形，改宽高或改边数时顶点重算。三角形只是 `sides: 3` 的实例，不存在独立的 `triangle` 类型。命令层在任何入口夹紧边数，GUI 与 AI 共用同一规则。详见 ADR-0013。

**矢量路径**：`path` 节点持有可选的 `vector` 字段（`{ closed, anchors }`）。锚点是节点本地坐标，`in/out` 是相对锚点的柄偏移（全 0 = 尖角）；节点框由锚点 + 手柄的包围盒推导。命令层收到 `vector` 时会把路径归一化到最小坐标 0，并把平移量计入节点 `x / y`，因此 GUI 与 AI 都可以直接给父容器坐标。详见 ADR-0012。

**组件、实例与插槽**：`component` 是页面顶层的主组件，持有 `propertyDefs`（文本、布尔、实例替换三种组件属性）；`instance` 是物化子树，持有 `componentId / mainId / propValues / overrides`，子孙节点都是真实节点并带 `mainId` 指回母版；`slot` 是具名内容区域，实例侧用 `slotFilled` 标记默认内容是否已被替换。实例子孙 id 由「实例 id + 母版节点身份键」确定性派生，保证同步、撤销与 AI 读写一致。详见 ADR-0014 与 §7。

## 4. 命令系统

命令是一条 JSON 记录：`{ type, params }`。核心约束：

1. **确定性**：同一文档状态 + 同一命令 = 唯一结果。禁止命令内读时间、随机数、外部资源（资源先注册、后引用）。
2. **可逆**：每条命令实现 `invert(doc)`，得到逆命令入撤销栈。
3. **原子**：一批命令先整批校验（`vector` 合法性等）再执行——要么全成、要么全不成；中途抛错不留「已生效但无法撤销」的改动。
4. **可合并**：连续手势（拖拽、调间距）走事务——`begin / update(重放) / commit`，提交时合并为一条命令写入 Op Log。
5. **命令展开**：`component.create`、`instance.create`、`instance.swap`、`component.detach`、`slot.*`、`property.*`、`instance.resetOverride` 在 `apply` 前展开成基础节点命令；母版同步与自动覆盖记录作为同一批命令追加。批命令校验时会把「同一批里先创建、后引用」的节点视为已存在。所有逆命令进同一个撤销条目。

撤销栈存逆命令流；每 N 条命令做一次**检查点快照**（内存），用于快速回退与崩溃恢复。文件持久化为"快照 + 增量操作日志"（见 §10）。

AI 工具最终也落到这套命令上：**GUI 和 Agent 是同一命令层的两个前端**，这是本架构最重要的不变式。

## 5. 渲染管线

`RenderBackend` 是核心与渲染之间的唯一接口：

```ts
interface RenderBackend {
  beginFrame(viewport: Viewport): void;
  /** 压入容器位移与绕中心的旋转，子节点相对容器绘制 */
  pushTransform(x: number, y: number, rotation?: number, width?: number, height?: number): void;
  popTransform(): void;
  /** 压入圆角矩形裁剪区（当前坐标系） */
  pushClip(x: number, y: number, width: number, height: number, radius: CornerRadius): void;
  popClip(): void;
  pushOpacity(alpha: number): void;
  popOpacity(): void;
  drawRect(node: DocNode, fill?: string, stroke?: string, strokeWidth?: number, radius?: CornerRadius, shadow?: boolean): void;
  drawEllipse(node: DocNode, fill?: string, stroke?: string, strokeWidth?: number): void;
  drawPath(node: DocNode, vector: VectorPath, fill?: string, stroke?: string, strokeWidth?: number): void;
  drawPolygon(node: DocNode, points: readonly Point[], fill?: string, stroke?: string, strokeWidth?: number): void;
  drawText(node: DocNode, fill?: string, stroke?: string): void;
  endFrame(): void;
}
```

- 绘制序 = 文档树深度优先（子在父上层），与图层面板顺序一致；
- 矢量路径由 `drawPath` 绘制：无手柄的段退化为直线，有手柄的段用三次贝塞尔；描边端点/拐角取圆角，填充用非零规则；
- 参数化多边形由 `drawPolygon` 绘制：顶点由 `polygonPoints(sides, width, height)` 在每帧推导（顶点朝上、撑满包围盒），同样支持旋转与填充/描边；
- 画板与矩形/组件共用同一套样式规则：有填充才画底色，无填充就是透明容器；画板不再强制白底、默认边框或投影。画板工具新建画板时默认填 `color/surface`，保持既有视觉；
- 插槽与画板/矩形共用样式绘制；空插槽占位与拖入高亮是 UI 叠加层，不进入文档渲染、导出或 AI 截图；
- 所有页面同屏渲染（无限画布）：页面是白底画板（带柔和投影与悬浮名称标签），子节点经 `pushTransform/popTransform` 应用容器偏移；
- **DPR 感知**：画布物理像素 = CSS 像素 × devicePixelRatio，视口变换矩阵统一处理平移缩放；
- v1 策略：**视口剔除 + 全视口重绘**（5k 节点预算内足够）；脏矩形与分层缓存列为撞墙后的升级项，不提前实现；
- 渲染器**无状态于文档**：每帧从 DocumentStore 拉取当前状态，杜绝渲染层缓存陈旧数据。

### 5.1 画布交互约定（UI 层，非文档状态）

**两种模式**（`ui.mode`，见 ADR-0010）：

- **拖动模式**：拖动页面之外的空白画布 = 平移；在页面上（含名称标签）拖动**不做任何事**，页面不会被移动；滚轮平移；单击/双击不改选区、不进编辑；进入时清空选区，检查器显示浏览占位；光标抓手/攥拳。
- **编辑模式**：只编辑活动页（`ui.activePageId`）；非活动页以 35% 不透明度淡化且不参与命中；**图层**可直接拖动；**页面只能拖名称标签移动**（页面空白处拖动不做任何事，避免误触整页位移），缩放仍可拖手柄；视图不能拖拽平移，但滚轮可以滚动（无边界）；缩放锚点固定为活动页中心。
- 切进编辑模式**只在必要时适配**：活动页可见面积 < 15% 才 `fit`，否则保持当前视图不动。
- 滚轮语义两种模式一致：普通滚轮 = 垂直平移（`deltaY / zoom`，`deltaMode` 行/页折算）；`⇧+滚轮` = 横向平移；`⌘/Ctrl + 滚轮` = 以**光标**为锚连续缩放（`exp(-deltaY × 0.0025)`）。按钮、缩放条、预设百分比仍按 1.2 倍一档，并锚活动页中心。
- 缩放条提供两个适配入口：「适配」（编辑模式 = 活动页，拖动模式 = 全部，`⇧1`）与「查看全部页面」（任何时候都适配所有页面，不切模式、不改选区与活动页，`⇧2`）。
- 活动页唯一：点击其它页面先切换再执行操作（含落笔绘图、左栏点其它页图层）；左栏页面行与画布共用同一活动页，切回编辑沿用上次活动页。
- `Esc` 分层退出：取消进行中的画布手势（拖动/缩放/绘制，什么都不提交）→ 关缩放菜单 → 取消行内编辑 → 取消改名 → 收尾钢笔草稿（≥2 锚点提交、1 个丢弃）→ 退出锚点编辑（保留选中）→ 清空选区 → 退出到拖动模式。`Esc` 在钢笔草稿期间是"结束并保留"，不是取消整条；撤销整条靠 `⌘Z`。

**命中与编辑**：

- 命中先按**活动页子节点的真实几何**判定（形状可以越出页面：路径、多边形、直线露出页面的部分同样可点中），再按页面矩形判定页面本身与切页；`path` / `polygon` / 带 `vector` 的 `line` 都按几何 + 5px 屏幕容差命中（直线不再依赖 1px 高的包围盒）；**无填充且无描边的形状不参与命中**（仍可从图层面板选中）；
- **双击语义**：活动页名称标签 → 重命名；`text` 节点 → 行内编辑；`path` 节点 → 进入锚点编辑；`polygon` 节点 → 普通选中（参数化形状不做逐点编辑）；其它节点 → 选中并同步检查器；页面空白 → 选中页面；
- **直线**仍是 `line` 节点，但用两点 `vector` 记录端点，保证水平/垂直线不会被最小尺寸夹成斜线；预览与提交方向一致。
- 拖拽移动有 **3px 屏幕阈值**，双击/手抖不会产生位移命令，也不会占撤销记录；
- 选中对象有 **8 个缩放手柄**（页面最小 200×200、其它节点最小 8×8）；`Shift` 等比（角手柄）；文本节点不给手柄（框随文字走，用「字号」控制）；多选只移动、不出手柄；
- 缩放页面/画板时子节点保持原相对位置与尺寸（不缩放、不裁切）；
- 拖动时显示**参考线**：目标为同父兄弟 + 父容器内容区（padding 内框）+ 父容器边界，边/中线对齐（6px 屏幕阈值，随缩放换算）+ 与最近对象的间距标注；拖动页面时父容器为空，候选是其它页面。绘制（只吸指针角）与缩放（只吸被拖动的边）同样参与，`⌥` 临时关闭吸附；参考线是纯 UI 覆盖层，不进文档、不进撤销；
- **拖动换父级**：每帧按指针求落点（最深的画板/组件，否则页面根；页面外不换父级），合法落点画虚线框 + 标签，松手提交 `node.reparent`（可带几何修正，整批 = 一个撤销条目）。主组件只能留页面顶层、实例子树内部不换父级、组件子节点不出组件、外部节点不拖进组件；不合法时沉默拒绝。落进自动布局容器默认进流（投影索引 + 插入线，兄弟按求解结果让位、hug 容器同步变尺寸，120ms 缓动，不吸附），`⌘` 落成绝对定位（无让位、无插入线）。跨页拖动中不切活动页，松手才切。细节见 `docs/specs/canvas-drag-reparent.md` 与 `docs/specs/layout-insert-preview.md`；
- **边缘自动滚屏**：移动拖拽中指针进入视口边缘 40px 起滚，速度按距离平方变速；每帧按同一屏幕坐标重算落点与参考线；
- **悬停子元素边界**：指针停在画板/组件/实例里时，描出其可见一级子元素的灰色虚线边界（容器开裁剪时裁到容器边界）；手势进行中隐藏，不影响命中与选中（`docs/specs/child-outlines.md`）；
- 检查器顶部显示选中对象的名称与完整 ID（页面同样适用），ID 可一键复制。

**钢笔（`P`）**：

- 点击 = 角点；按下拖拽 = 平滑锚点（镜像手柄、对侧长度保留），`⌥` 断链只动当前侧；双击锚点把两侧手柄归零。
- 点回首锚闭合（至少 3 个锚点，8px 吸附）；`Enter` / 双击空白结束开放路径；`Esc` 结束并保留；草稿期间 `⌘Z` / `Delete` / `Backspace` 删除最后一个锚点，不触碰文档撤销栈。
- `⇧` 把下一段约束到 45°；必须在页面内起笔，后续锚点可越出页面；相邻重合点去重。
- 切工具 / 切模式 / 点画布以外 / 窗口失焦都按 `Esc` 规则收尾；结束时一次性 `node.create`，回到选择工具并选中新路径。
- 双击路径进入**锚点编辑**：隐藏 8 个缩放手柄，显示全部锚点与当前锚点的手柄；拖锚点/手柄改形（联动规则同上），拖本体移动整条；`Esc` 退出并保留选中。一次拖动 = 一条 `node.update`。
- 命中：无填充/开放路径按实际描边距离（5px 屏幕容差）；有填充的闭合路径内部也算命中。
- 默认样式：开放 = `color/text` 2px 描边；闭合 = `color/primary` 填充；检查器可改填充、描边、线宽与闭合状态。

**渲染期预览**：拖动/缩放过程通过 `drawDocument` 的 `movePreview` / `resizePreview` 选项偏移或替换几何（路径缩放同时用 `vectorPreview` 缩放锚点，布局让位用 `geometryPreview` 覆盖子项与容器几何），文档只在 pointerup 时提交：普通拖动是一条 `node.update`，换父级是 `node.reparent` + 几何/尺寸修正的批次（同样一步撤销）。

**三角形（`G`）/ 多边形**：

- 角对角拖出包围盒，拖拽中直接画真实多边形轮廓；`⇧` 在三角形上锁正三角形比例 `1 : √3/2`（以拖动更长的方向为基准）。
- 创建的是 `polygon` 节点（`sides: 3`），默认名「三角形 N」、填充 `color/primary`、无描边；其它边数默认名「多边形 N」。
- 检查器：类型标签按 `sides` 显示「三角形 / 多边形」；「边数」输入夹在 3–12，改边数不改包围盒；不显示圆角。
- 命中：有填充时内部可点；无填充时按描边距离（5px 屏幕容差），与路径同一策略。
- 双击 = 普通选中，不进锚点编辑；顶点不能逐点拖动（参数化形状）。

### 5.2 面板与快捷键（UI 层，非文档状态）

- **左栏 tab**：`对话 | 页面 | 组件 | 设计系统`，默认停在对话；每次刷新都回到对话（不持久化）；`⌘K` 切到对话并聚焦输入框。
- **页面面板**：页面列表可搜索（忽略大小写子串 + 命中片段高亮 + 「命中 / 总数」徽标），过滤不改变手风琴与展开状态；`⌘F` 从任意位置切到页面 tab 并聚焦搜索框（全局动作，已在框内则全选）。
- **设计系统面板**：按路径前缀分组列出 `DocState.tokens`（可折叠、可过滤）；颜色行用色块 + 完整路径 + hex（色块点开系统取色器），数字行给数值输入；**改值 / 新增 / 双击改名都走命令**（`token.define` / `token.rename`，可撤销，引用随动）。v1 不支持删除、不统计引用。
- **快捷键注册表**（`apps/web/src/shortcuts.ts`）：动作表 + 默认键位 + `localStorage` 覆盖（只存差异）+ 冲突校验 + 全局分发。tooltip、面板、画布、对话全部从 `keyOf()` 读取，禁止硬编码键位文案（见 ADR-0011）。
- **快捷键面板**是居中对话框（遮罩 + 对话框），点行就地录制；`Esc` / 点遮罩 / `⌘/` 关闭；冲突与浏览器保留键当场拒绝；「恢复默认」需 3 秒内二次确认。
- 单键快捷键在输入框（input / textarea / select / contentEditable）内一律让位；文件与对话类命令（`⌘O / ⌘S / ⌘K`）除外。

## 6. 自动布局求解器

纯函数：`solveLayout(spec, children, availW?, availH?) → { items, contentWidth, contentHeight }`。契约：

- 输入：方向、gap、四边 padding、主/交叉轴对齐、`wrap` / `crossGap` / `alignContent`；每个子项的尺寸行为（fixed / hug / fill + min/max）、可见性、绝对定位；
- 输出：子项在容器 border box 内的 `x/y/width/height`，以及容器内容所需尺寸（供 hug 写回）；
- `availW/availH` 为 `undefined` 表示该轴 hug：不分配 fill、不按 space-between 拉伸；
- 算法：**两遍法**——先确定主轴尺寸（fill 只在单行分配剩余空间），再分行/交叉轴排布；
- **wrap 下 fill 退化为 fixed**：换行后没有稳定的剩余空间可分配，避免固定点迭代；
- 隐藏子项退出排布；绝对定位子项原样保留（X/Y 相对容器左上角，忽略 padding）；
- 交叉轴 `stretch` 只作用于 `fixed` / `fill` 子项：`hug` 与文本自动尺寸必须保持内容尺寸，否则会与测量写回形成循环；
- 明确不做：基线对齐、CSS grid、百分比尺寸。

新建 `frame` / `component` 默认带自动布局：纵向、`gap 10`、四边 `padding 10`、尺寸 fixed（`defaultLayoutFor`）。默认只作用于新建入口（工具栏、AI `create_node`）；历史文档、由既有节点转成的组件、实例物化都不套默认布局。检查器保留“移除布局”，移除后子项保持当前几何。

求解发生在**事务末尾**：从受影响节点向上收集布局容器，自底向上各求解一次，几何写回作为内部 `node.update` 与用户命令共用同一个撤销条目。文档几何是唯一真源，没有 `layoutCache`。

换父级与布局的交界：拖进自动布局容器默认按投影插入（`reorderIndexAt` + 插入线），`⌘` 则保留世界坐标并置 `layoutAbsolute`；同父重排复用同一条 `node.reparent`（同父 + 索引）。离开布局父级时 `fill` 归一成 `fixed`，避免在非布局容器里出现无意义的尺寸行为。插入让位预览直接用同一套 `solveLayout` 求解（剔除移动根、插入等尺寸幽灵子项），渲染层通过 `geometryPreview` 覆盖几何，不改文档。

派生几何（布局求解、文本测量）不写入实例覆盖表；hug 轴与 fill 轴的尺寸也不记录为覆盖。

## 7. 组件系统

- **主组件**是页面顶层的 `component` 节点，持有 `propertyDefs`（文本、布尔、实例替换三种属性）；组件里只能放实例，不能放组件。
- **实例**是物化子树：实例根带 `componentId / mainId / propValues / overrides`，子孙都是真实节点并带 `mainId`；子孙 id 由「实例 id + 母版节点身份键」确定性派生。实例可跨页引用。
- **同步**：母版结构、样式、尺寸、名称变化后，按组件依赖拓扑序重建所有实例；嵌套组件先于外层；母版与实例同属一个撤销条目。展开是纯函数，不读时间/随机，不在执行期生成新 id。
- **字段级覆盖**：编辑实例内部字段时，命令层按 `mainId` 逐字段比对母版，写入/清除 `NodeOverride`；`style` 可只覆盖子字段。实例根的尺寸与名称可覆盖，位置与可见性属于实例自身；自动布局容器内的几何覆盖不生效。
- **组件属性**：属性优先于覆盖，绑定字段不能再写覆盖；文本/布尔/实例替换分别驱动 `text`、`visible`、嵌套实例的 `componentId`。属性有稳定 id，改名不影响实例值；删除属性或删除目标图层会清理实例值并回落母版。
- **插槽**：母版里的 `slot` 节点具名且组件内唯一，可有默认内容；实例首次填充整体替换默认，清空恢复默认；已填充插槽内容不参与母版同步；删除已填充的母版插槽直接拒绝。
- **替换**：位置不变、尺寸取新组件；同名已填充插槽内容保留；跨组件 `mainId` 交集通常为空，覆盖随之丢弃；形成组件循环的替换被拒绝。
- **脱离**：实例转 `frame`（继承样式/尺寸），插槽转画板（空槽删除），嵌套实例仍为实例；删除主组件或含主组件的页面时，引用它的实例先自动脱离。
- **未交付**：枚举属性与变体（组件集合）、跨文件组件库、作用域插槽。

## 8. Token 系统

- Token：`{ path: "color/primary", type: "color", value: "#3366ff" }` —— 单一取值，不引入模式/主题维度（见 ADR-0006）；
- 节点样式存**Token 引用** `{ token: "color/primary" }`，渲染前解析为具体值（解析结果按 token 键控缓存）；
- **改名是原子命令**（`token.rename from → to`）：一次 apply 内搬条目并重写所有节点的 `style.fill.token` / `style.stroke.token`，只占一步撤销；源不存在或目标重名直接抛错，不做静默 no-op。**删除**暂无命令（v1 范围外），删除会留下悬空引用，需连带迁移策略再做；
- 导出：W3C DTCG 格式 JSON + 一键生成 CSS 变量；
- **Agent 纪律**：工具 schema 中样式参数只接受 Token 引用，字面量色值在工具层直接拒绝——这是让 AI 产出可控、可维护的核心手段。

## 9. 文本与字体

- 整段单一样式：字体族、字重、斜体、字号、行高（auto / px / %）、字距（px / %）、段距（px）、水平对齐（left / center / right / justify）、垂直对齐（top / middle / bottom）、大小写、装饰、列表（无 / 项目符号 / 编号）、fixed 高度截断；富文本 runs 仍在 v1.5。
- 字体族是**受控栈**：Geist / Geist Mono / 系统无衬线 / 系统衬线 / 系统等宽；字重 100–900；不做字体导入与可变字体轴。
- `textAutoResize` 三模式：`auto-width`（不换行）、`auto-height`（固定宽度换行，高度随内容）、`fixed`（宽高固定，可截断）。检查器改 W/H 会切到 fixed。
- 行盒算法在 `packages/core/src/text.ts`（纯函数，宽度测量由调用方注入）：换行、列表缩进、段落间距、截断省略号都由它产出，Canvas 渲染与检查器测量共用同一份结果。
- 测量留在 UI 层：`apps/web/src/text-metrics.ts` 注入 Canvas `measureText`，提交前一次性写回 `text + width/height`；AI 工具通过 `makeExecutor` 的测量参数获得同一能力，无测量的宿主按字号估算。
- 行内编辑使用 **contenteditable** 浮层：与画布共享字体、行高、字距、对齐、装饰与列表 CSS；`⌘Enter` 提交、Esc 取消、失焦提交。编辑期间画布停绘该节点。

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

1. **内置对话面板**：BYOK——Provider 管理（添加时可选预置 OpenCode Go，或自定义任意 OpenAI 兼容接入点：DeepSeek / Ollama 等）；模型为**全局选择**、位于底部输入区，历史会话存 IndexedDB（自动标题、可删除）；无可用模型时输入禁用并引导添加 Provider；标准工具调用循环（模型 → 工具调用 → core 执行 → 结果回填 → 继续）；
2. **MCP Server**：把同一套工具定义挂到 MCP 协议上，外部 agent（Claude Code 等）可直接驱动 Sqraft。

工具清单（v1）：

| 工具 | 读/写 | 说明 |
|---|---|---|
| `read_document` | 读 | 返回页面/节点树的紧凑摘要 |
| `get_tokens` | 读 | Token 集合与取值 |
| `create_page / create_node` | 写 | 建页面/节点（样式仅接受 Token 引用） |
| `update_node` | 写 | 改属性（同上约束） |
| `delete_node / move_node` | 写 | 结构操作 |
| `set_component_property` | 写 | 组件/实例属性操作 |
| `screenshot` | 读 | 渲染指定区域为 PNG，回传给多模态模型自检 |
| `export_assets` | 读 | 导出切图，返回文件 |
| `set_prototype_link` | 写 | 页面间原型连线 |

**截图自检闭环**：agent 生成 → `screenshot` → 模型看图 → 修正命令。这是"AI 全流程"质量的下限保障。

**矢量路径**：`create_node` 的 `kind` 支持 `path`，用 `points`（父容器坐标）与 `closed` 描述锚点；`update_node` 可整体替换 `points` 或切换 `closed`；`read_document` 回传 `vector`。颜色仍只接受 `fillToken` / `strokeToken`，未给颜色时按 GUI 默认（开放描边、闭合填充）。

**参数化多边形**：`create_node` 的 `kind` 支持 `polygon`，用 `sides`（3–12，默认 3）指定边数、`width/height` 指定包围盒；`update_node` 可改 `sides`；`read_document` 回传 `sides`。默认填充 `color/primary`，颜色规则与其它节点一致。

## 13. 性能预算

- 单文件 ≤ 5,000 节点，拖拽/缩放/滚动 60fps（中端笔记本）；拉伸目标：2 万节点可浏览；
- 打开 < 2s，内存 < 500MB；
- 手势期间命令走事务高频通道，不触发 Vue 全量响应（画布状态独立于响应式系统）。

## 14. 测试策略

- **布局求解 golden 测试**：手工构造布局用例集（含 wrap、min/max 边界），快照对比位置输出——求解器是纯函数，这是最便宜的高价值测试；
- **命令确定性测试**：随机命令序列重放两次，文档状态逐字节相等；文件"快照+重放"等价性测试；
- **矢量几何测试**：包围盒归一化（含手柄）、宽高缩放、闭合约束、贝塞尔采样与命中，全部在 core 的纯函数层做（Node 下运行，不需 DOM）；
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
