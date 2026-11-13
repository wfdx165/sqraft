# Sqraft 总体架构设计

> 术语以 [GLOSSARY.md](../GLOSSARY.md) 为准。本文描述 v1 的目标架构与各子系统契约。

## 1. 总览

Sqraft 是纯单机桌面应用（Electron 壳 + Vue 3 / Canvas 2D 渲染层），读写本地 `.sqraft` 文件，并把 `packages/ai-tools` 的工具定义作为 MCP Server 暴露给外部 agent。应用内不调用任何模型端点。架构的唯一主轴是：**一切编辑都是命令，一切消费方（GUI、AI、撤销重做、持久化）都走命令层**。

```
┌─────────────────────────────────────────────────────┐
│  apps/desktop（Electron 壳 + Vue 3 渲染层）                             │
│  工具栏 / 图层面板 / 检查器 / 欢迎页                    │
└───────────────┬─────────────────────┬───────────────┘
                │ 用户事件 → 命令        │ 工具调用
┌───────────────▼─────────────┐ ┌─────▼───────────────┐
│  packages/core（领域核心）    │ │  packages/ai-tools   │
│  文档模型 / 命令系统          │◄──┤  工具 schema（唯一真源）│
│  布局求解 / Token / 组件      │ │  MCP 与 GUI 共用       │
└───────────────┬─────────────┘ └─────────────────────┘
                │ 状态变更事件
┌───────────────▼─────────────┐
│  packages/render（渲染）      │
│  RenderBackend 接口          │
│  Canvas2D 实现 / 视口 / 命中   │
└─────────────────────────────┘
```

依赖方向自上而下单向：`desktop → core ← render`，`ai-tools → core` 的类型。`core` 不依赖任何 UI/渲染/浏览器 API（可在 Node 下测试）。

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
├── backend.ts    RenderBackend 接口 + 世界↔屏幕坐标
├── canvas2d.ts   Canvas 2D 实现（含效果离屏合成）
└── renderer.ts   文档树遍历与绘制序（命中检测在 apps/desktop/src/renderer/canvas/hit.ts）

packages/ai-tools/src/
└── tools.ts      工具定义（JSON Schema + 执行器类型）
```

## 3. 文档模型

**扁平存储 + 树不变量**。文档是一张节点表（`Map<NodeId, Node>`），父子关系由 `parentId` / `children` 表达，满足不变量：

- 每个节点有且仅有一个父节点（页面节点除外，其父为文档）；
- 树无环；删除节点递归删除子树。

扁平表让命令（按 id 定位）与序列化（天然 JSON）都简单，也让未来协作（按节点 id 合并）有落点。

页面是 `rootIds` 中的 `page` 节点（`rootIds` 同时装页面与主组件，`getPages` 按类型过滤），携带 `x / y / width / height`（默认 1440×1024），可在无限画布上自由拖动；新建页面自动放到最右侧页面之右（间距 160）。画布同时渲染所有页面，子节点坐标相对父容器（页面或画板），渲染与命中检测按祖先链累加偏移。

节点公共字段：`id / type / name / parentId / children / x / y / width / height / rotation / opacity / visible / locked / clip`。坐标相对父节点内容区左上角，旋转绕自身中心；`clip` 只对画板/组件/实例生效。

自动布局相关字段（子项侧）：`layoutSizingW/H`（fixed / hug / fill）、`layoutMinW/H`、`layoutMaxW/H`、`layoutAbsolute`。文本节点另有 `textAutoResize`（auto-width / auto-height / fixed）、`listType`、`truncate`。

节点类型（v1）：`page / frame / group / rect / ellipse / line / polygon / star / path / text / image / instance / component / slot`。

**参数化多边形**：`polygon` 节点持有可选的 `sides`（3–12，默认 3），顶点由包围盒推导——包围盒就是形状的外接矩形，改宽高或改边数时顶点重算。三角形只是 `sides: 3` 的实例，不存在独立的 `triangle` 类型。命令层在任何入口夹紧边数，GUI 与 AI 共用同一规则。详见 ADR-0013。

**矢量路径**：`path` 节点持有可选的 `vector` 字段（`{ closed, anchors }`）。锚点是节点本地坐标，`in/out` 是相对锚点的柄偏移（全 0 = 尖角）；节点框由锚点 + 手柄的包围盒推导。命令层收到 `vector` 时会把路径归一化到最小坐标 0，并把平移量计入节点 `x / y`，因此 GUI 与 AI 都可以直接给父容器坐标。详见 ADR-0012。

**组件、实例与插槽**：`component` 是文档根节点上的主组件（不属于任何页面，见 ADR-0025），持有 `propertyDefs`（文本、布尔、实例替换三种组件属性）；`instance` 是物化子树，持有 `componentId / mainId / propValues / overrides`，子孙节点都是真实节点并带 `mainId` 指回母版；`slot` 是具名内容区域，实例侧用 `slotFilled` 标记默认内容是否已被替换。实例子孙 id 由「实例 id + 母版节点身份键」确定性派生，保证同步、撤销与 AI 读写一致。详见 ADR-0014 与 §7。

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
- **节点效果**（见 ADR-0018）：`style.effects` 是有序列表，投影 / 内阴影 / 图层模糊 / 背景模糊共用一条管道 —— 带可见效果的节点先把自绘与整棵子树画进离屏，按 pad（`blur + |offset| + |spread|`）外扩，再逐条施加效果，裁剪回节点形状，最后合成回当前层。半径是文档单位（随缩放），离屏长边封顶 2048 设备像素、超出按比例降采样；效果不改变包围盒，不影响命中与布局。父容器 `clip` 会裁掉子节点的效果；内阴影与两种模糊受节点自身圆角裁剪，投影不受；
- **背景模糊**取样“该节点之下、文档层已经画好的内容”，因此画布拆成**三块**：网格层（下）→ 文档层（中，渲染后端独占）→ UI 叠加层（上，指针事件与坐标换算也在这里）。网格因此不会被糊进毛玻璃，UI 叠加层也始终清晰；
- **不透明度是组隔离**：`opacity < 1` 的节点先合成子树再整体乘一次 alpha（逐绘制操作乘 alpha 的做法已废弃，它会让半透明容器内重叠处偏深）；离屏尺寸取「子树包围盒 ∩ 视口」，因此再大的画板在屏幕上也只有一屏大小的离屏，且不透明度层不降采样（降采样会糊文字）；
- 所有页面同屏渲染（无限画布）：页面是白底画板（带柔和投影与悬浮名称标签），子节点经 `pushTransform/popTransform` 应用容器偏移；
- **DPR 感知**：画布物理像素 = CSS 像素 × devicePixelRatio，视口变换矩阵统一处理平移缩放；
- 重绘策略：**全视口重绘**（画布只在脏标记置位时重绘）+ **根节点级视口剔除**（ADR-0032）：页面 / 主组件整棵子树的保守包围盒与视口不相交就跳过，淡化页面的不透明度层按该页包围盒开；包围盒缓存由画布持有、按文档版本失效。效果层、蒙版层与整页（页面 / 根级主组件）的绘制结果跨帧缓存（ADR-0033，按 `id @ epoch` 与变换签名命中，预览 / 编辑中的节点及祖先、背景模糊不缓存；缩放手势中拉伸旧缓存，停下后分帧补清晰）；屏幕上不到半个像素的叶子跳过；图片按屏幕所需分辨率分级解码；只有一次绘制的半透明叶子直接乘 alpha。子树内剔除与脏矩形仍是撞墙后的升级项；
- 渲染器**无状态于文档**：每帧从 DocumentStore 拉取当前状态，杜绝渲染层缓存陈旧数据。

### 5.1 画布交互约定（UI 层，非文档状态）

**两种模式**（`ui.mode`，见 ADR-0010）：

- **拖动模式**：拖动页面之外的空白画布 = 平移；在页面上（含名称标签）拖动**不做任何事**，页面不会被移动；滚轮平移；**单击页面（位移 ≤ 3px）= 切活动页并适配该页**，双击不改选区、不进编辑；按住拖动仍然是平移；进入时清空选区，检查器显示浏览占位；光标抓手/攥拳。
- **编辑模式**：只编辑活动页（`ui.activePageId`）；非活动页以 35% 不透明度淡化且不参与命中；**图层**可直接拖动；**页面与母版只能拖名称标签移动**（页面空白处拖动不做任何事，避免误触整页位移；母版子节点常铺满矩形，标签是唯一入口），缩放仍可拖手柄；视图不能拖拽平移，但滚轮可以滚动（无边界）；缩放锚点固定为活动页中心。
- 切进编辑模式**只在必要时适配**：活动页可见面积 < 15% 才 `fit`，否则保持当前视图不动。
- 滚轮语义两种模式一致：普通滚轮 = 垂直平移（`deltaY / zoom`，`deltaMode` 行/页折算）；`⇧+滚轮` = 横向平移；`⌘/Ctrl + 滚轮` = 以**光标**为锚连续缩放（`exp(-deltaY × 0.0025)`）。按钮、缩放条、预设百分比仍按 1.2 倍一档，并锚活动页中心。
- 缩放条提供两个适配入口：「适配」（编辑模式 = 活动页，拖动模式 = 全部，`⇧1`）与「查看全部」（任何时候都适配所有根节点——页面 + 组件区，不切模式、不改选区与活动页，`⇧2`）。
- 活动页唯一：点击其它页面先切换再执行操作（含落笔绘图、左栏点其它页图层）；左栏页面行与画布共用同一活动页，切回编辑沿用上次活动页。
- **切页即适配**：左栏点页面行、画布上点另一页、拖动模式单击页面都走同一条路——切活动页 + 该页铺满视口（padding 80，`pageFitViewport`）；点当前页不重复缩放。左栏行首小三角只控制图层列表的展开/折叠，不动视口。
- `Esc` 分层退出：取消进行中的画布手势（拖动/缩放/绘制，什么都不提交）→ 关缩放菜单 → 取消行内编辑 → 取消改名 → 收尾钢笔草稿（≥2 锚点提交、1 个丢弃）→ 退出锚点编辑（保留选中）→ 清空选区 → 退出到拖动模式。`Esc` 在钢笔草稿期间是"结束并保留"，不是取消整条；撤销整条靠 `⌘Z`。

**命中与编辑**：

- 命中先按**活动页子节点的真实几何**判定（形状可以越出页面：路径、多边形、直线露出页面的部分同样可点中），再按页面矩形判定页面本身与切页；`path` / `polygon` / 带 `vector` 的 `line` 都按几何 + 5px 屏幕容差命中（直线不再依赖 1px 高的包围盒）；**无填充且无描边的形状不参与命中**（仍可从图层面板选中）；
- **根节点名称标签**：页面与根级主组件各有一个标签（`canvas/labels.ts`），图标与左栏共用 `renderer/icons.ts` 的路径——页面是画板图标、母版是组件菱形，母版标签用紫色（与实例/母版的选中色同源）。按住标签拖动 = 移动整页 / 整块母版（页面与母版的**唯一**拖动入口：母版子节点常常铺满整个矩形，画布上没有像素能命中母版本体），双击 = 行内改名，右键 = 页面菜单 / 节点菜单；拖动模式下单击页面仍是切页 + 适配，不弹菜单；
- **双击语义**：`text` 节点 → 行内编辑；`path` 节点 → 进入锚点编辑；`polygon` 节点 → 普通选中（参数化形状不做逐点编辑）；其它节点 → 选中并同步检查器；页面空白 → 选中页面；
- **直线**仍是 `line` 节点，但用两点 `vector` 记录端点，保证水平/垂直线不会被最小尺寸夹成斜线；预览与提交方向一致。
- 拖拽移动有 **3px 屏幕阈值**，双击/手抖不会产生位移命令，也不会占撤销记录；
- 选中对象有 **8 个缩放手柄**（页面最小 200×200、其它节点最小 8×8）；`Shift` 等比（角手柄）；文本节点不给手柄（框随文字走，用「字号」控制）；多选只移动、不出手柄；
- 缩放页面/画板时子节点保持原相对位置与尺寸（不缩放、不裁切）；
- 拖动时显示**参考线**：目标为同父兄弟 + 父容器内容区（padding 内框）+ 父容器边界，边/中线对齐（6px 屏幕阈值，随缩放换算）+ 与最近对象的间距标注；拖动页面时父容器为空，候选是其它页面。绘制（只吸指针角）与缩放（只吸被拖动的边）同样参与，`⌥` 临时关闭吸附；参考线是纯 UI 覆盖层，不进文档、不进撤销；
- **拖动换父级**：每帧按指针求落点（最深的画板/组件，否则页面根；页面外不换父级），合法落点画虚线框 + 标签，松手提交 `node.reparent`（可带几何修正，整批 = 一个撤销条目）。根节点（页面、主组件）不换父级、实例子树内部不换父级、组件子节点不出组件、外部节点不拖进组件；不合法时沉默拒绝。落进自动布局容器默认进流（投影索引 + 插入线，兄弟按求解结果让位、hug 容器同步变尺寸，120ms 缓动，不吸附），`⌘` 落成绝对定位（无让位、无插入线）。跨页拖动中不切活动页，松手才切。细节见内部规格「拖动换父级」与「布局插入预览」（`docs/specs/`，不随仓发布）；
- **边缘自动滚屏**：移动拖拽中指针进入视口边缘 40px 起滚，速度按距离平方变速；每帧按同一屏幕坐标重算落点与参考线；
- **库对象的悬停与选中**：实例与主组件用紫色 `#8b5cf6`——悬停画 1px 虚线 `[4,3]`（无手柄、无尺寸徽标），选中画 1.5px 实线 + 同色手柄与徽标；其它图层仍用 indigo `#4f46e5`。悬停框与命中结果一致：没进入实例时高亮整个实例，进入后高亮命中的子节点；`accentOf` 是唯一取色入口（`canvas/selection-overlay.ts`）。
- **悬停子元素边界**：指针停在画板/组件/实例里时，描出其可见一级子元素的灰色虚线边界（容器开裁剪时裁到容器边界）；手势 / 编辑态进行中隐藏（与选中量距同一套 `busy` 门禁），不影响命中与选中（细节见内部规格「悬停子元素边界」，`docs/specs/`，不随仓发布）；
- **选中量距**：选中图层后，标出它与同父兄弟在上/下/左/右各最近一个之间的间距（`gap > 0` 才画，最多 4 条；端点屏幕距离 < 8px 不画，避免数字叠在一起）；只显示整数、不带单位，样式与拖动时的间距标注一致（`canvas/selection-spacing.ts`）。同父多选用选区包围盒参与计算、跨父级多选不画；受编辑模式 + `select` 工具约束，框选 / 拖参考线 / 拖动 / 钢笔 / 裁切 / 行内编辑期间都不画（`showSelectionSpacing` 统一收口），不受「显示参考线」开关影响；
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

- **左右面板常驻**：左栏（页面 / 组件 / 设计系统）与右侧检查器都不提供收起入口，窗口变窄也不自动收起；工具栏按"画布区"（两侧固定面板宽度之间）居中与收窄，窗口不足时靠平移 / 缩放应对。
- **左栏 tab**：`页面 | 组件 | 设计系统`，默认停在页面；tab 不持久化。
- **图层树**：所有有子元素的容器（画板 / 分组 / 组件 / 实例 / 插槽）都可折叠——单击整行 = 选中 + 切换折叠（`⇧` 多选只选中不切换），行首小三角展开时朝下、折叠时朝右；默认实例折叠、其它容器展开，状态存在 `ui.expandedLayers`（纯 UI，不进文档/撤销/磁盘），折叠不改变选区与画布选中框。
- **页面面板**：页面列表可搜索（忽略大小写子串 + 命中片段高亮 + 「命中 / 总数」徽标），过滤不改变手风琴与展开状态；`⌘F` 从任意位置切到页面 tab 并聚焦搜索框（全局动作，已在框内则全选）。点页面行 = 切页 + 适配该页（再点当前页也会重新适配）；行首小三角单独控制该页图层的展开/折叠。
- **设计系统面板**：按路径前缀分组列出 `DocState.tokens`（可折叠、可过滤）；颜色行用色块 + 完整路径 + hex（色块点开系统取色器），数字行给数值输入；**改值 / 新增 / 双击改名 / 删除都走命令**（`token.define` / `token.rename` / `token.delete`，可撤销，引用随动）。删除仍被引用的 Token 会先要求确认，确认后把引用冻结成当前取值的字面量，与删除包成同一条撤销——不做"删了就变洋红"的悬空引用；平时不统计引用数，只在这个确认动作里算一次。
- **快捷键注册表**（`apps/desktop/src/renderer/shortcuts.ts`）：动作表 + 默认键位 + `localStorage` 覆盖（只存差异）+ 冲突校验 + 全局分发。tooltip、面板、画布全部从 `keyOf()` 读取，禁止硬编码键位文案（见 ADR-0011）。
- **快捷键面板**是居中对话框（遮罩 + 对话框），点行就地录制；`Esc` / 点遮罩 / `⌘/` 关闭；冲突与浏览器保留键当场拒绝；「恢复默认」需 3 秒内二次确认。
- 单键快捷键在输入框（input / textarea / select / contentEditable）内一律让位；文件类命令（`⌘O / ⌘S`）与页面搜索（`⌘F`）除外。

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

- **主组件**是文档根节点上的 `component` 节点（与页面平级，不属于任何页面；详见 ADR-0025），持有 `propertyDefs`（文本、布尔、实例替换三种属性）；组件里只能放实例，不能放组件。画布上先画页面、后画母版，母版永远浮在页面之上；新建母版排到「页面整体包围盒下方 + 间距」的组件区，从左往右一行；缩放到全部时组件区一起取景。绘制哪些根节点由 `rootDrawPlan` 决定：画布渲染画全部，**页面导出只取该页并跳过母版**（母版压在页面上也不会进 PNG）。
- **组件面板**平铺列出全文档母版（不按页面分组）：单击 = 选中母版并飞行定位（不产实例），双击或行尾「+」= 在活动页插入实例（视口中心不落在活动页上时夹回页面内）；左栏页面树只有页面。
- **实例**是物化子树：实例根带 `componentId / mainId / propValues / overrides`，子孙都是真实节点并带 `mainId`；子孙 id 由「实例 id + 母版节点身份键」确定性派生。实例可跨页引用。
- **同步**：母版结构、样式、尺寸、名称变化后，按组件依赖拓扑序重建所有实例；嵌套组件先于外层；母版与实例同属一个撤销条目。展开是纯函数，不读时间/随机，不在执行期生成新 id。
- **字段级覆盖**：编辑实例内部字段时，命令层按 `mainId` 逐字段比对母版，写入/清除 `NodeOverride`；`style` 可只覆盖子字段。实例根的尺寸与名称可覆盖，位置与可见性属于实例自身；自动布局容器内的几何覆盖不生效。
- **组件属性**：属性优先于覆盖，绑定字段不能再写覆盖；文本/布尔/实例替换分别驱动 `text`、`visible`、嵌套实例的 `componentId`。属性有稳定 id，改名不影响实例值；删除属性或删除目标图层会清理实例值并回落母版。
- **插槽**：母版里的 `slot` 节点具名且组件内唯一，可有默认内容；实例首次填充整体替换默认，清空恢复默认；已填充插槽内容不参与母版同步；删除已填充的母版插槽直接拒绝。
- **替换**：位置不变、尺寸取新组件；同名已填充插槽内容保留；跨组件 `mainId` 交集通常为空，覆盖随之丢弃；形成组件循环的替换被拒绝。
- **脱离**：实例转 `frame`（继承样式/尺寸），插槽转画板（空槽删除），嵌套实例仍为实例；删除主组件时引用它的实例先自动脱离。母版不在页面里，删除页面不牵连母版。
- **未交付**：枚举属性与变体（组件集合）、跨文件组件库、作用域插槽。

## 8. Token 系统

- Token：`{ path: "color/primary" | "spacing/md", type: "color" | "number", value }` —— 单一取值，不引入模式/主题维度（见 ADR-0006）；
- 节点存**引用**、使用时解析（ADR-0028）：
  - 颜色：`style.fill.token` / `style.stroke.token` / 阴影 `color.token`；
  - 数值：`fontSizeToken`、`lineHeightToken`、`letterSpacingToken`、`paragraphSpacingToken`、`strokeWidthToken`、逐角 `cornerRadiusTokens`、`layout.gapToken` / `crossGapToken` / 逐边 `paddingTokens`。
  - 解析入口是 `packages/core/src/token-resolve.ts`：Token 有效则覆盖字面量，缺失/类型不对回退字面量；渲染、布局求解、文本测量、检查器展示都走同一套。数值 Token 改值会标脏引用节点，布局 pass 重算、文本 reflow 重新测量。
- **改名是原子命令**（`token.rename from → to`）：一次 apply 内搬条目并重写所有节点的颜色引用**与数值引用**（style / layout），**同时改写实例覆盖表**（`instance.overrides[key].style` / `.layout`——它是另一份持久化差异，漏掉的话下一次组件同步会把旧路径写回克隆节点），只占一步撤销；源不存在或目标重名直接抛错，不做静默 no-op；
- **删除**（`token.delete`，MCP 侧是 `delete_token` 的 `detach`）：有引用时先把引用冻结成当前取值的字面量再删（数值引用逐角/逐边只冻结对应项），仍是同一条撤销；实例覆盖由 `recordOverrides` 按克隆节点的新 style 重算，天然自愈；
- **检查器**：颜色走填充/描边下拉；数值字段旁有 Token 按钮（`TokenLink`）打开 `TokenPicker`（只列数值 Token）。统一圆角/内边距的按钮一次绑四角/四边，分角/分边各自独立；手改字面量自动解绑对应槽位。
- 导出：W3C DTCG 格式 JSON + 一键生成 CSS 变量；
- **Agent 纪律**：颜色与数值都可以引用 Token，也可以给字面量；两者同时出现时 Token 优先（ADR-0024）。

## 9. 文本与字体

- 整段单一样式：字体族、字重、斜体、字号、行高（auto / px / %）、字距（px / %）、段距（px）、水平对齐（left / center / right / justify）、垂直对齐（top / middle / bottom）、大小写、装饰、列表（无 / 项目符号 / 编号）、fixed 高度截断；富文本 runs 仍在 v1.5。
- 字体族是**受控栈**：Geist / Geist Mono / 系统无衬线 / 系统衬线 / 系统等宽；字重 100–900；不做字体导入与可变字体轴。
- `textAutoResize` 三模式：`auto-width`（不换行）、`auto-height`（固定宽度换行，高度随内容）、`fixed`（宽高固定，可截断）。检查器改 W/H 会切到 fixed。
- 行盒算法在 `packages/core/src/text.ts`（纯函数，宽度测量由调用方注入）：换行、列表缩进、段落间距、截断省略号都由它产出，Canvas 渲染与检查器测量共用同一份结果。
- 测量留在 UI 层：`apps/desktop/src/renderer/text-metrics.ts` 注入 Canvas `measureText`，提交前一次性写回 `text + width/height`；AI 工具通过 `makeExecutor` 的测量参数获得同一能力，无测量的宿主按字号估算。
- 行内编辑使用 **contenteditable** 浮层：与画布共享字体、行高、字距、对齐、装饰与列表 CSS；`⌘Enter` 提交、Esc 取消、失焦提交。编辑期间画布停绘该节点。

## 10. 文件格式

`.sqraft` 是一个 zip 容器：

```
manifest.json      格式版本、生成应用版本
doc.json           最近一次快照
ops.ndjson         快照之后的增量命令流
assets/            图片位图（按内容哈希命名，level: 0 不压缩）
```

- 图片节点两种来源：嵌入图只记 `assetId` 与原图尺寸，字节在 `assets/`（同一张图多处使用只存一份，ADR-0022）；**链接图只记 `sourceUrl`**，字节不进文件、按 URL 缓存在 `userData/image-cache/`（ADR-0027）。链接图的 `naturalWidth/Height` 在首次抓取前为 0，`crop` 缺省表示整图。

- 打开文件 = 载入快照 + 重放增量（确定性命令保证重放安全）；
- 保存时若增量超过阈值则折叠为新快照；
- 读取走快速路径（ADR-0033）：按中央目录取条目，图片（存储条目）是原缓冲区的零拷贝视图，`doc.json` 用原生 `DecompressionStream` 解压（不是 Worker，不受 CSP 限制），认不出的结构退回 `unzipSync`；
- 保存一律**同步压缩**（`zipSync`，`fileio.ts`）：不依赖 Web Worker——打包版 CSP 不放行 `blob:`，fflate 异步 API 用的 blob worker 被拦后回调永不触发（保存曾因此静默挂死）。代价是文档很大时 UI 有可感知停顿：预检上限 300MB 兜住极端体积（超限弹窗并给出降体积建议），预估超 20MB 先 toast 预告再压缩；
- `formatVersion` 单调递增，读取端只向前兼容；**遇到比自己新的格式版本直接拒绝**并提示升级（ADR-0029），迁移走显式迁移函数、只在渲染层执行。

## 11. 存储层

- 文件操作全部在主进程：系统对话框选文件；打开时主进程只登记一次性取件地址 `sqraft-doc://file/<token>`（128 位随机、只能读一次、60 秒过期），渲染层 `fetch` 流式取回字节，不经 IPC 整块克隆（ADR-0033）；`.sqraft` 的序列化/解析仍只在渲染层（主进程不懂格式）。
- **全手动保存**：磁盘文件只在用户按保存时变化，没有自动写回，也没有崩溃恢复快照（明确取舍）。
- 写盘走"同目录临时文件 + rename"的原子替换；保存前比对 mtime，文件被外部改过时提示"覆盖 / 另存为"。
- 关闭窗口/退出时由主进程拦下，向渲染层询问是否有未保存改动；"保存 / 不保存 / 取消"由系统对话框呈现。

## 12. AI 层

**单插槽：MCP**（见 ADR-0004）。应用把 `packages/ai-tools` 的工具定义挂在 MCP 协议上，外部 agent（Claude Code、Cursor 等）通过**本机 HTTP** 接入并驱动 Sqraft；应用自身不调用模型、不保存密钥。

接入链路（ADR-0026）：

- 主进程跑 MCP server（自实现的最小协议层，不引 SDK），端点为 `http://127.0.0.1:<port>/mcp`，走规范 **Streamable HTTP**：`POST` 收 JSON-RPC，`initialize` 下发 `Mcp-Session-Id`，`DELETE` 结束会话；支持 `2025-11-25` / `2025-06-18` / `2025-03-26`，更老的版本按规范回落到最新受支持版本；
- 不提供 SSE：`GET /mcp` 返回 `405`，`POST` 直接回 `application/json`；应用退出时不广播通知；
- 会话空闲 30 分钟过期；界面上"在线"= 最近 2 分钟有请求的会话（HTTP 没有连接，只能按活动推断），详情最多列 5 条、其余只报数量；标签取 `initialize.params.clientInfo`；应用必须保持运行，没有 CLI 负责拉起；
- 端口默认 `7331`：显式填写的端口严格遵守（占用即报错），自动模式被占时向上顺延并持久化实际端口，界面显性告警；
- 安全：只绑 `127.0.0.1`，拒绝带 `Origin` 的请求，`Host` 只接受本机；**无 token**——同机其他用户也能连，这是相对 Unix socket 的显式取舍；
- 多客户端并存，所有工具调用进同一队列串行执行；单次调用 30s 超时；会话结束（`DELETE` / 过期）时排队中的调用直接丢弃；
- **一次工具调用只执行一次**：渲染层的监听宿主登记在 `globalThis` 上，重复安装先摘掉旧监听，并按主进程分配的调用号去重（同号的重复投递静默丢弃）。dev 热更新会重新执行渲染层模块，少了这一层，旧实例的监听会和新实例一起处理同一条调用——`create_node` 会落两个节点（返回 id 之外多一个没有子节点的副本）；
- 工具清单与执行器都在渲染进程（`@sqraft/ai-tools` 的唯一真源），主进程只转发；截图只取文档层画布，不含编辑器叠加层。

**操作日志**：会话创建、`tools/list`、每次 `tools/call` 的耗时与错误都以 `[mcp]` 单行写终端（info/warn → stdout，error → stderr）并追加到 `app.getPath("logs")/sqraft.log`（macOS `~/Library/Logs/Sqraft/`），不经 `console`。同一份日志还有两种来源：主进程事件标 `[app]`（生命周期、文件类 IPC、对话框），渲染层上报标 `[renderer]`（快捷键分发、保存链路、未捕获错误）——渲染层拿不到文件系统，只经 `app:log` 白名单通道发"事件 + 字段"。参数只记摘要——长字符串截断、`data:image` 折叠成类型与体积，规则单点在 `src/main/mcp/log.ts`；落盘与轮转（10MB × 10 个文件）在 `src/main/log-file.ts`，写失败静默降级为仅终端。身份来自客户端 `initialize` 的 `clientInfo`（如 `c1 claude-code/2.1`）。排障用的端口与进程信息写在 `userData/mcp.json`（0600），那不是客户端发现机制。帮助菜单的「打开日志目录」直接定位到日志。

工具清单（v1）：

| 工具 | 读/写 | 说明 |
|---|---|---|
| `read_document` | 读 | 返回页面/节点树的紧凑摘要；根级主组件放在 `components`（与会话树分开），`includeComponentTrees=true` 才附母版子树 |
| `get_selection` | 读 | 画布当前选区：`activePageId`（当前活动页，不代表选区所属页面）+ 每个选中节点的 id / 名字 / 类型 / 世界坐标 / 尺寸；空选区给 hint。改还是走显式 `nodeId` |
| `get_tokens` | 读 | Token 集合与取值；没有 Token 时返回空表 |
| `define_token` | 写 | 新增/覆盖 Token（颜色接受 #hex 3/6/8 位、rgb/rgba；不能改类型） |
| `rename_token` | 写 | 重命名 Token，fill / stroke / 阴影颜色引用随动 |
| `delete_token` | 写 | 删除 Token。仍被节点引用时默认拒绝；`detach=true` 把引用冻结成当前取值的字面量再删（视觉不变，一条撤销） |
| `create_page` | 写 | 新建页面（省略名字按「页面 N」编号；位置默认接在最右侧） |
| `create_node` | 写 | 建节点（颜色可引用 Token，也可给字面量）；`kind=component` 不接受 `parentId`，省略坐标自动排到组件区；`kind=image` 给 `image.data`（base64，≤5MB）或 `image.url`（http/https 链接，字节不进文件） |
| `update_node` | 写 | 改属性与名字（页面 / 图层 / 组件；颜色规则同上）；图片可用 `crop` 改可见区域、`imageUrl` 换远程链接 |
| `delete_node` | 写 | 删除节点 |
| `duplicate_node` / `group_nodes` / `arrange_nodes` | 写 | 复制、分组/解组、对齐/分布 |
| `move_node` | 写 | 换父级（等价画布拖动，世界坐标不变；自动布局容器默认进流） |
| `create_instance` / `swap_instance` / `detach_instance` | 写 | 组件实例的建立、替换与解绑 |
| `define_property` / `set_instance_prop` / `fill_slot` | 写 | 组件属性定义、实例属性覆盖、插槽填充 |
| `import_font` | 写 | 导入字体文件（base64，≤5MB），返回字族/字重/风格 |
| `inspect_layout` | 读 | 世界坐标、绝对定位、自动布局与 hug/fill 数据 |
| `export_png` | 读 | 页面或选区按倍率渲染 PNG（透明底选区）；页面导出只画该页，不含根级母版 |
| `screenshot` | 读 | 离屏重绘文档为 PNG（不含编辑器叠加层）；可选 `region` 只截文档坐标下的某块 |
| `document.new` | 写 | 新建未命名空稿并切换过去 |
| `document.open` | 写 | 只能触发系统文件对话框；不接受路径参数（agent 不能读任意磁盘文件） |

**画布反馈**：写工具执行期间，画布在 UI 叠加层给这次调用的改动画青色虚线框——只取最外层节点（建一棵子树只描根框），页面本身不描（整页虚线没有信息量），`delete_node` 改描父容器（父容器是页面时同样跳过）；调用结束 480ms 淡出。顶部胶囊同时显示「客户端 · 工具名」，跨页或改动在视口外时多一个跳转按钮（切页 + 飞行定位到改动包围盒；跨页切页按 `activatePage` 既有规则清空选区，不额外选中改动节点；一次调用跨多页时只指向第一处改动），调用结束后残留 5 秒再回落到连接数。只读工具与失败的写调用都不碰画布，后者不留下"刚改了…"的字样。状态住在非响应式的 `renderer/canvas/agent-activity.ts`，因此不进 `RenderBackend`、不进导出，也不进 `screenshot`。

**撤销粒度**：一次工具调用里的多条命令通过 `DocStore.transact` 合并成单条撤销记录；事务失败时回滚，文档不会停在半成品状态。

**截图自检闭环**：agent 生成 → `screenshot` → 模型看图 → 修正命令。这是"AI 全流程"质量的下限保障。

**矢量路径**：`create_node` 的 `kind` 支持 `path`，用 `points`（父容器坐标）与 `closed` 描述锚点；`update_node` 可整体替换 `points` 或切换 `closed`；`read_document` 回传 `vector`。颜色可引用 `fillToken` / `strokeToken`，也可给 `fill` / `stroke` 字面量；未给颜色时按 GUI 默认（开放描边、闭合填充）。

**参数化多边形**：`create_node` 的 `kind` 支持 `polygon`，用 `sides`（3–12，默认 3）指定边数、`width/height` 指定包围盒；`update_node` 可改 `sides`；`read_document` 回传 `sides`。默认填充 `#3366ff`，颜色规则与其它节点一致。

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
| 各平台文件对话框差异 | 中 | 主进程统一封装，只有路径分隔符与文件名规则需要分平台 |
| 多模态截图反馈的模型差异 | 低 | 截图统一为定尺寸 PNG；工具结果结构化 |
| Canvas 2D 性能撞墙 | 低 | RenderBackend 抽象已就位，可换 WebGL2 后端不动文档模型 |

## 16. 桌面壳与进程边界

- **进程**：主进程（MCP 宿主、文件 IO、窗口/菜单/生命周期）＋ 渲染进程（文档真源、命令层、渲染器、AI 工具执行器）＋ preload（白名单桥）。主进程不持有 `DocState`。
- **IPC**：通道名与请求/响应类型集中在 `shared/ipc`，preload 只暴露 `window.sqraft` 一个对象；渲染层拿不到 `require` 与任意 IPC。安全基线见 ADR-0019。
- **文件**：主进程负责系统对话框、字节搬运、原子写与 mtime 比对；`.sqraft` 的序列化/解析/迁移只在渲染层。全手动保存，无自动写回、无崩溃恢复。
- **窗口**：单窗口两态（欢迎页 / 一个文档）；**每次启动把窗口铺满它上次所在那块屏的工作区**（不是 macOS 全屏模式，菜单栏与 Dock 仍在）；`⌘W` 关闭文档回欢迎页，`⌘Q` 退出；单实例转发打开请求；窗口位置与最近列表存 `userData/preferences.json`。macOS 用 `hiddenInset` 标题栏（左上红绿灯 + 58px 留白 + 拖拽条）；Windows 用系统默认标题栏、菜单栏常显，应用内不留那段留白（ADR-0033）。快捷键在 Windows 上显示为 `Ctrl+Shift+Z` 形式，内部存储仍是同一套规范串。
- **欢迎页**：以 MCP 接入为主位——服务状态（监听中 / 在线会话数）、能力一行（工具数动态取自 `@sqraft/ai-tools`）、可复制的接入片段（Claude Code / OpenCode / Cursor / 通用），然后才是新建/打开与最近 4 条。三态（未启动 / 等待接入 / 已连接）只改状态行与主按钮，见 ADR-0021 与 ADR-0026。
- **菜单与快捷键**：系统级动作走菜单 role；文档编辑类动作仍由渲染层注册表独占，菜单点击只发送同一个动作 id（ADR-0011 的桌面补充）。
- **MCP**：主进程协议层 + 本机 Streamable HTTP（`127.0.0.1:<port>`），详见 ADR-0026 与 §12。
- **更新**（ADR-0029 / ADR-0033）：主进程负责检查（`releases/latest/download/latest.json`，24 小时节流）。macOS arm64 会下载 zip 并校验 sha256、退出时用 detached 脚本替换 `.app`；备份 + 启动标记（60 秒）构成回滚：新版本没跑起来就换回旧包。Windows **只提示**：版本更新时状态置为 `available`，界面给「前往下载」打开 Releases 页面，不下载、不安装。渲染层只显示状态、触发重启或打开下载页，不碰文件系统。只承诺 macOS arm64 的就地更新（macOS 包自 2026-11 起签名 + 公证，见 ADR-0034；替换脚本落位前校验新包签名与 Team）；只读位置（dmg 挂载点）提前拒绝。
- **打包**（ADR-0033）：electron-builder，`appId com.yjsoft.sqraft`；asar 打包，没有需要放到 asar 外的可执行文件。macOS 出 arm64 的 dmg + zip（zip 供自动更新）；Windows 出 x64 的 NSIS 安装器（`Sqraft-Setup-<version>.exe`，per-user、可改目录、四语安装器、关联 `.sqraft`、卸载保留用户数据）。Windows 包必须在 Windows 机器上构建（`pnpm dist` 按宿主平台出包，不交叉构建），`release/` 是上传前的唯一产物收件箱。`verify-pack` 同时支持 `.app` 与 `win-unpacked` 两种布局。
- **构建期防护**（ADR-0030）：三个入口都 esbuild 压缩、不生成 sourcemap；`dependencies` 必须为空（渲染层与主进程的依赖全在构建期 bundle 进去，成品不含 `node_modules`）；`afterPack` 翻转 Electron fuse（禁 `RunAsNode` / `NODE_OPTIONS` / 调试参数，只允许从 asar 加载）。`scripts/verify-pack.mjs` 在发版链路里断言以上全部成立，不成立就中止。`.sqraft` 仍是明文 zip。
- **版本与标识**：版本号唯一真源是 `apps/desktop/package.json`（手动修改；`pnpm release` 只读、不接受版本参数）；发版的硬门槛是 `docs/releases/vX.md` 存在且非空，脚本不检查本地分支、工作区或 tag，`latest.json` 也不记录 commit；`appId` 沿用 `com.yjsoft.sqraft`——0.0.2 起已对外使用，改名会让已装用户被 macOS 当成另一个应用，因此保持不变。
- **界面语言**（ADR-0031）：`zh-CN` / `en-US` / `ja-JP` / `ko-KR`，`auto` 跟随系统（`zh*` / `ja*` / `ko*`，其余英文）+ 设置面板手动覆盖；主进程与渲染层共用 `src/shared/i18n` 的类型化字典，界面文案一律走 `t()`；界面与新建文本按语言切换 CJK 字体栈，日文换行带轻量禁则；日志、MCP 工具描述、README/docs 与更新说明不在本地化范围。核心对用户可触发的错误抛 `AppError`，界面按 code 翻译。

## 17. 原型链接与演示模式

- **数据**：`DocNode.interactions?: Interaction[]`（ADR-0032）。每条是 `{ id, trigger: "click", action: "navigate" | "back", targetId?, transition: { type: "instant" | "dissolve", durationMs } }`；`targetId` 只能是 `page` 节点。页面另有 `scrollDirection?: "none" | "vertical" | "horizontal"`，只影响演示模式。数组是**整组替换**语义（与 `patch.style` 同纪律）。
- **校验**：`packages/core/src/interaction.ts` 的 `normalizeInteractions` 是唯一入口——条数、id 唯一性、目标类型、不能指向自己所在页面、转场白名单、时长夹紧。`DocStore.validateOne` 抛错、`applyOne` 归一化；GUI 与 MCP 共用。
- **引用完整性**：`node.delete` 删除页面前先展开引用清理（同一事务）；`node.reparent` 离开页面子树时清掉子树链接；跨文档粘贴丢弃找不到目标的链接；实例物化不复制母版链接。
- **编辑入口**：右栏「设计 / 原型」两个 tab（`ui.inspectorTab`）。原型 tab 编辑第一条交互（目标页 / 返回上一屏、转场、时长），第 2 条起只读；选中页面时改为「滚动」下拉。画布上选中或悬停热区时画正交连线（目标页不可见则退化为胶囊），悬停会向上冒泡到热区祖先。
- **演示模式**（`ui.presenter = { pageId, scroll, stack }`，纯 UI 状态）：`Presenter.vue` 覆盖整个窗口，用 `drawDocument(..., { onlyPageIds })` + `pageFitViewport` 画单页，裁到页面矩形后应用滚动位移；命中从页面子树向下找、再向上冒泡；`←` 退栈、`H` 高亮热区、`Esc` 退出。不写文档、不改选区与视口，退出即卸载。
- **让位规则**：`ui.presenter` 非空时，快捷键分发器与画布的 `onKey` 都直接 return——两道显式闸门，不依赖事件捕获顺序。
- **AI**：`set_interaction` / `remove_interaction` / `list_interactions`；`read_document` 的节点摘要带 `links`。一次工具调用 = 一个撤销步。
