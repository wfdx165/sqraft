/**
 * AI 工具定义：内置对话面板与 MCP Server 的唯一真源（ADR-0004）。
 * 纪律：颜色优先引用 Token，也可以直接用字面量（ADR-0024）。
 */

import type {
  Command,
  DocNode,
  DocState,
  DocStore,
  Effect,
  NodeId,
  NodeStyle,
  VectorAnchor,
} from "@sqraft/core";
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  clampSides,
  createLayoutSpec,
  createNode,
  defaultLayoutFor,
  firstPageId,
  makeAnchor,
  newId,
  getPages,
  getRootComponents,
  nextComponentPosition,
  nextPageName,
  nextPagePosition,
  planDuplicate,
  type AlignEdge,
  type DistributeAxis,
  type ReorderAction,
  nextComponentName,
  planTokenDelete,
  validateVector,
  tokenColorOf,
  tokenNumberOf,
  tokenPathOf,
  walkSubtree,
  worldRect,
  type CornerRadius,
  type LayoutSpec,
  type Padding,
  type TextAutoResize,
} from "@sqraft/core";

/** create_node / update_node 共用的排版与外观字段。 */
const STYLE_SCHEMA: Record<string, unknown> = {
  fillToken: { type: "string", description: "填充色的 Token 名，如 color/primary；与 fill 二选一，Token 优先" },
  fill: { type: "string", description: "填充色的字面量（如 #3366ff）；没有设计系统时直接给色值" },
  strokeToken: { type: "string", description: "描边色的 Token 名；与 stroke 二选一，Token 优先" },
  stroke: { type: "string", description: "描边色的字面量（如 #1a1a1a）" },
  strokeWidth: { type: "number", description: "描边线宽" },
  cornerRadius: {
    description: "圆角：数字表示四角统一；也可传 { topLeft, topRight, bottomRight, bottomLeft }",
    oneOf: [
      { type: "number" },
      {
        type: "object",
        properties: {
          topLeft: { type: "number" },
          topRight: { type: "number" },
          bottomRight: { type: "number" },
          bottomLeft: { type: "number" },
        },
        additionalProperties: false,
      },
    ],
  },
  fontFamily: { type: "string", description: "受控字体栈，如 'Geist Variable', 'PingFang SC', sans-serif" },
  fontWeight: { type: "number", description: "100–900" },
  fontStyle: { type: "string", enum: ["normal", "italic"] },
  fontSize: { type: "number" },
  lineHeight: { type: "number" },
  lineHeightUnit: { type: "string", enum: ["auto", "px", "percent"] },
  letterSpacing: { type: "number" },
  letterSpacingUnit: { type: "string", enum: ["px", "percent"] },
  paragraphSpacing: { type: "number" },
  textAlign: { type: "string", enum: ["left", "center", "right", "justify"] },
  textVerticalAlign: { type: "string", enum: ["top", "middle", "bottom"] },
  textCase: { type: "string", enum: ["none", "upper", "lower", "title"] },
  textDecoration: { type: "string", enum: ["none", "underline", "strikethrough"] },
  textAutoResize: { type: "string", enum: ["auto-width", "auto-height", "fixed"] },
  listType: { type: "string", enum: ["none", "bulleted", "numbered"] },
  truncate: { type: "boolean" },
  effects: {
    description:
      "节点效果列表，从下到上依次施加：投影 drop-shadow、内阴影 inner-shadow、图层模糊 layer-blur、背景模糊 backdrop-blur。传 [] 清空。阴影颜色只能用 fillToken 引用 Token（禁止字面量）。",
    type: "array",
    items: {
      oneOf: [
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["drop-shadow", "inner-shadow"] },
            visible: { type: "boolean" },
            x: { type: "number", description: "偏移 X（文档单位）" },
            y: { type: "number", description: "偏移 Y（文档单位）" },
            blur: { type: "number", description: "模糊半径（文档单位，≥0）" },
            spread: { type: "number", description: "扩散（文档单位，可为负）" },
            fillToken: { type: "string", description: "阴影颜色的 Token 名，如 color/shadow" },
          },
          required: ["type", "fillToken"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["layer-blur", "backdrop-blur"] },
            visible: { type: "boolean" },
            radius: { type: "number", description: "模糊半径（文档单位，≥0）" },
          },
          required: ["type"],
          additionalProperties: false,
        },
      ],
    },
  },
};

/** 节点几何/布局字段。 */
const NODE_SCHEMA: Record<string, unknown> = {
  x: { type: "number" },
  y: { type: "number" },
  width: { type: "number" },
  height: { type: "number" },
  rotation: { type: "number", description: "旋转角度（度）" },
  opacity: { type: "number", description: "0–1" },
  visible: { type: "boolean" },
  locked: { type: "boolean" },
  clip: { type: "boolean", description: "仅 frame/component：裁剪子节点" },
  layoutSizingW: { type: "string", enum: ["fixed", "hug", "fill"] },
  layoutSizingH: { type: "string", enum: ["fixed", "hug", "fill"] },
  layoutMinW: { type: "number" },
  layoutMinH: { type: "number" },
  layoutMaxW: { type: "number" },
  layoutMaxH: { type: "number" },
  layoutAbsolute: { type: "boolean" },
  layout: {
    type: "object",
    description: "自动布局：只允许 frame/component。padding 支持数字或四边对象。",
    properties: {
      direction: { type: "string", enum: ["horizontal", "vertical"] },
      gap: { type: "number" },
      padding: {
        oneOf: [
          { type: "number" },
          {
            type: "object",
            properties: {
              top: { type: "number" },
              right: { type: "number" },
              bottom: { type: "number" },
              left: { type: "number" },
            },
            additionalProperties: false,
          },
        ],
      },
      mainAlign: { type: "string", enum: ["start", "center", "end", "space-between"] },
      crossAlign: { type: "string", enum: ["start", "center", "end", "stretch"] },
      wrap: { type: "boolean" },
      crossGap: { type: "number" },
      alignContent: { type: "string", enum: ["start", "center", "end", "space-between", "stretch"] },
    },
    additionalProperties: false,
  },
};

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  readonly?: boolean;
}

export const tools: ToolDefinition[] = [
  {
    name: "read_document",
    description:
      "读取当前文档的页面与节点树紧凑摘要。组件节点带 propertyDefs，实例带 componentId / propValues / overrides，插槽带 slotFilled。主组件是文档根节点，不在页面树里：`components` 给摘要（含 propertyDefs），要改母版内部结构时传 includeComponentTrees=true 连内部节点树一起返回。返回 JSON 字符串。",
    readonly: true,
    input_schema: {
      type: "object",
      properties: {
        includeComponentTrees: {
          type: "boolean",
          description: "true = components 里附上母版的完整节点树（subtree），默认只给摘要",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_selection",
    description:
      "读取画布当前选区（用户正在选中的节点），返回活动页 id 与每个选中节点的摘要：id / name / type / parentId / 世界坐标 x,y / width / height / locked / visible，实例还带 componentId、实例子孙带 mainId。想对「用户选的东西」动手时先调它，再把 nodeId 显式传给 update_node / arrange_nodes 等工具。选区为空时给空数组与 hint。只读。",
    readonly: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_tokens",
    description:
      "读取设计 Token 集合与取值；没有 Token 时返回空表。样式可以引用 Token（fillToken / strokeToken），也可以直接给 fill / stroke 字面量。",
    readonly: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "define_token",
    description:
      "新增或覆盖一个设计 Token。path 形如 color/primary、spacing/md（至少含一个 /，不能有空格或空段）；type=color 时 value 接受 #hex（3/6/8 位）、rgb() / rgba()（带 alpha 也可用 8 位 hex），type=number 时接受有限数值。已存在的同类型路径覆盖取值（可撤销）；不能把已有 Token 改成另一种类型。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Token 路径，如 color/primary" },
        type: { type: "string", enum: ["color", "number"] },
        value: { description: "color 传字符串，number 传数字", oneOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["path", "type", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "rename_token",
    description:
      "重命名设计 Token；节点里对旧路径的 fill / stroke / 阴影颜色引用会一起改过去（可撤销）。旧路径不存在或目标路径已存在时拒绝。",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "原路径" },
        to: { type: "string", description: "新路径" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_token",
    description:
      "删除一个设计 Token。仍被节点引用时默认拒绝；detach=true 会把引用冻结成当前取值的字面量再删除（视觉不变，可撤销）。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Token 路径，如 color/primary" },
        detach: {
          type: "boolean",
          description: "仍有引用时是否把它们冻结为字面量；省略或 false 时有引用直接报错",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "create_page",
    description:
      "新建一个页面并返回 pageId。页面是根节点，不能嵌在其它节点里；省略 name 时按「页面 N」自动编号，省略 x/y 时放在最右侧页面之右。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "页面名；省略自动编号" },
        x: { type: "number", description: "省略时放在最右侧页面之右" },
        y: { type: "number", description: "省略时与最上方页面对齐" },
        width: { type: "number", description: "默认 1440" },
        height: { type: "number", description: "默认 1024" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_node",
    description:
      "在父节点下创建一个节点。kind 支持 frame/rect/ellipse/polygon/line/path/text/image/component/slot。component 是文档根节点（不接受 parentId；x/y 省略时自动排到画布上的组件区）；slot 必须位于主组件内并提供唯一名字。polygon 是参数化多边形，用 sides 指定边数（3–12，默认 3，3 即三角形），顶点由 width/height 包围盒推导。path 用 points 描述锚点（父容器坐标，手柄为相对锚点的偏移），闭合路径至少 3 个锚点、开放路径至少 2 个。image 用 image.data 传 base64（上限 5MB），不接受文件路径。颜色可引用 fillToken / strokeToken，也可直接给 fill / stroke 字面量（Token 优先）。",
    input_schema: {
      type: "object",
      properties: {
        parentId: { type: "string", description: "父节点 id；省略则建到当前页面" },
        kind: { type: "string", enum: ["frame", "rect", "ellipse", "polygon", "line", "path", "text", "image", "component", "slot"] },
        name: { type: "string", description: "slot 必填且组件内唯一" },
        sides: { type: "number", description: "kind=polygon 的边数，3–12，默认 3" },
        text: { type: "string", description: "kind=text 时的文案" },
        image: {
          type: "object",
          description:
            "kind=image 时二选一：data（base64，不含 data: 前缀）+ mimeType（上限 5MB），或 url（http/https 链接，字节不进文件，按需抓取并缓存在本机）",
          properties: {
            data: { type: "string" },
            mimeType: { type: "string" },
            url: { type: "string", description: "http/https 图片地址；懒加载，断网时用本地缓存" },
          },
          additionalProperties: false,
        },
        closed: { type: "boolean", description: "kind=path 时是否闭合，默认 false" },
        points: {
          type: "array",
          minItems: 2,
          description: "kind=path 的锚点，父容器坐标；x/y 必填，inX/inY/outX/outY 为相对锚点的手柄偏移",
          items: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              inX: { type: "number" },
              inY: { type: "number" },
              outX: { type: "number" },
              outY: { type: "number" },
            },
            required: ["x", "y"],
            additionalProperties: false,
          },
        },
        ...NODE_SCHEMA,
        ...STYLE_SCHEMA,
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "create_instance",
    description:
      "插入一个组件实例，自动物化整棵子树。parentId 省略时放到当前页面；x/y 是相对父容器的坐标。",
    input_schema: {
      type: "object",
      properties: {
        componentId: { type: "string" },
        parentId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        name: { type: "string" },
      },
      required: ["componentId"],
      additionalProperties: false,
    },
  },
  {
    name: "define_property",
    description:
      "在组件母版的图层上创建组件属性。type=text 要求目标为文本图层，boolean 控制可见性，instance 控制嵌套实例替换成哪个组件。返回 propertyId。",
    input_schema: {
      type: "object",
      properties: {
        componentId: { type: "string" },
        targetNodeId: { type: "string" },
        type: { type: "string", enum: ["text", "boolean", "instance"] },
        name: { type: "string", description: "显示名；省略则用图层名" },
      },
      required: ["componentId", "targetNodeId", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "set_instance_prop",
    description:
      "设置或清除实例的属性值。文本用字符串、布尔用 true/false、实例替换用组件 id；null 表示清除并回落到母版值。",
    input_schema: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
        propertyId: { type: "string" },
        value: { description: "字符串 / 布尔 / 组件 id；null 清除" },
      },
      required: ["instanceId", "propertyId", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "fill_slot",
    description:
      "把已有节点填入实例的具名插槽。首次填充会整体替换默认内容；节点保持世界坐标。",
    input_schema: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
        slotName: { type: "string" },
        nodeIds: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["instanceId", "slotName", "nodeIds"],
      additionalProperties: false,
    },
  },
  {
    name: "swap_instance",
    description: "把实例替换成另一个组件；位置不变，同名已填充插槽内容保留。",
    input_schema: {
      type: "object",
      properties: { instanceId: { type: "string" }, componentId: { type: "string" } },
      required: ["instanceId", "componentId"],
      additionalProperties: false,
    },
  },
  {
    name: "detach_instance",
    description: "把实例脱离为普通画板，不再受母版影响。",
    input_schema: {
      type: "object",
      properties: { instanceId: { type: "string" } },
      required: ["instanceId"],
      additionalProperties: false,
    },
  },
  {
    name: "update_node",
    description:
      "更新节点属性（含改名）。颜色可引用 fillToken / strokeToken，也可给 fill / stroke 字面量（Token 优先）。polygon 可用 sides 改边数（3–12）。path 可用 points（父容器坐标）整体替换锚点、用 closed 切换闭合；只改 width/height 时锚点会按比例缩放。图片节点可用 crop 改可见区域（原图像素坐标）、用 mask 标记为蒙版（遮罩同父级上方相邻兄弟）。",
    input_schema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        name: { type: "string", description: "新名字；页面 / 图层 / 组件都可改" },
        text: { type: "string" },
        sides: { type: "number", description: "polygon 的边数，3–12" },
        closed: { type: "boolean" },
        crop: {
          type: "object",
          description: "图片的可见区域（原图像素坐标）；省略的字段保持原值",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          additionalProperties: false,
        },
        mask: { type: "boolean", description: "true = 作为蒙版，遮罩同父级上方相邻兄弟" },
        imageUrl: {
          type: "string",
          description: "把图片节点换成这个 http/https 链接（字节不进文件，按需抓取）；裁切会重置为整图",
        },
        backgroundImage: {
          type: "object",
          description: "页面背景图（仅 page）：给 data + mimeType，或直接给已有 assetId；fit 缺省 cover",
          properties: {
            data: { type: "string", description: "base64 图片字节（≤5MB）" },
            mimeType: { type: "string" },
            assetId: { type: "string", description: "已存在的图片资源 id" },
            fit: { type: "string", enum: ["cover", "contain", "tile"] },
          },
          additionalProperties: false,
        },
        points: {
          type: "array",
          minItems: 2,
          description: "path 的新锚点，父容器坐标；与 create_node 的 points 同构",
          items: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              inX: { type: "number" },
              inY: { type: "number" },
              outX: { type: "number" },
              outY: { type: "number" },
            },
            required: ["x", "y"],
            additionalProperties: false,
          },
        },
        ...NODE_SCHEMA,
        ...STYLE_SCHEMA,
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "move_node",
    description:
      "把节点换父级（等价画布上的拖动），世界坐标保持不变。目标是自动布局容器时默认进流（追加到末尾，可用 index 指定插入位），absolute=true 则落成绝对定位子项。主组件是文档根节点，不能移动父级；页面、实例子树内部同样拒绝。",
    input_schema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        parentId: { type: "string", description: "新的父节点（画板 / 分组 / 组件 / 实例 / 页面）" },
        index: { type: "number", description: "在 flow 里的插入位置；省略为末尾" },
        absolute: { type: "boolean", description: "true = 绝对定位（不进流）" },
      },
      required: ["nodeId", "parentId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_node",
    description: "删除节点及其子树。",
    input_schema: {
      type: "object",
      properties: { nodeId: { type: "string" } },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "group_nodes",
    description:
      "把多个节点打成一个分组（Figma 语义：无填充、不裁剪、尺寸等于子节点并集，缩放组等于缩放子节点）。返回新分组 id。",
    input_schema: {
      type: "object",
      properties: {
        nodeIds: { type: "array", items: { type: "string" }, minItems: 1 },
        name: { type: "string", description: "分组名；省略时自动编号" },
      },
      required: ["nodeIds"],
      additionalProperties: false,
    },
  },
  {
    name: "arrange_nodes",
    description:
      "排列一组节点：六种对齐（单选对父容器内容区、多选对选区包围盒）、两种等间距分布（至少 3 个）、四种层级调整。自动布局子项会被拒绝（位置由布局决定）。",
    input_schema: {
      type: "object",
      properties: {
        nodeIds: { type: "array", items: { type: "string" }, minItems: 1 },
        action: {
          type: "string",
          enum: [
            "align-left",
            "align-h-center",
            "align-right",
            "align-top",
            "align-v-center",
            "align-bottom",
            "distribute-h",
            "distribute-v",
            "bring-forward",
            "send-backward",
            "bring-to-front",
            "send-to-back",
          ],
        },
      },
      required: ["nodeIds", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "duplicate_node",
    description: "原地复制节点（含整棵子树，组件引用与覆盖一起重映射），返回新根节点 id 列表。",
    input_schema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        offsetX: { type: "number", description: "相对原件的水平偏移，默认 10" },
        offsetY: { type: "number", description: "相对原件的垂直偏移，默认 10" },
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "import_font",
    description:
      "导入一份字体文件（字节内联，不收路径）：支持 ttf/otf/woff/woff2，单文件 ≤5MB。返回字族、字重与风格，之后用 fontFamily 引用。",
    input_schema: {
      type: "object",
      properties: {
        fileName: { type: "string", description: "文件名（用于无法读取元数据时兜底命名）" },
        dataBase64: { type: "string", description: "字体文件的 base64" },
      },
      required: ["fileName", "dataBase64"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_layout",
    description:
      "读取页面或指定节点的布局数据：世界坐标几何、是否绝对定位、自动布局参数（方向/gap/padding/wrap）与 hug-fill 行为。只读。",
    input_schema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "页面 id；省略时用当前活动页" },
        nodeIds: { type: "array", items: { type: "string" }, description: "只取这些节点（含子树）；省略则整页" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "export_png",
    description:
      "按倍率把页面或一组节点渲染成 PNG data URL（不含选中框/参考线等 UI 叠加层）。有 nodeIds 时导出选区（透明背景），否则导出整页（带页面背景）。",
    input_schema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "页面 id；省略时用当前活动页" },
        nodeIds: { type: "array", items: { type: "string" }, description: "要导出的节点（透明背景）" },
        scale: { type: "number", description: "倍率 1–4，默认 2" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description:
      "截取当前画布视口为 PNG（data URL），用于自检生成结果。只包含设计稿本身（不含网格、选中框、参考线）。可用 region 只截文档坐标下的某个范围，例如某个画板。",
    readonly: true,
    input_schema: {
      type: "object",
      properties: {
        region: {
          type: "object",
          description: "文档坐标下的矩形；省略则截整个视口",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "document.new",
    description: "新建一份未命名空稿并切换过去。",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "document.open",
    description: "让用户通过系统文件对话框选择一个 .sqraft 并打开。不接受路径参数——文件必须由用户亲自选择。",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

/** 截图区域（文档坐标）；省略表示整个视口。 */
export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 文档级操作由宿主提供：工具层不直接碰文件系统与窗口。 */
export interface DocumentHost {
  /** 返回是否真的新建了；用户在"保存 / 不保存 / 取消"里选取消时返回 false。 */
  newDocument(): Promise<boolean>;
  /**
   * 把 base64 位图落进资源仓库，返回 assetId 与原图尺寸。
   * 只收数据、不收路径——工具层不允许读任意文件。
   */
  addImage?(data: string, mimeType: string): Promise<{ assetId: string; width: number; height: number }>;
  /** 返回是否真的打开了文件；用户取消返回 false。 */
  openDocument(): Promise<boolean>;
  /** 切到某个页面：create_page 后让「省略 parentId」的后续操作落到新页 */
  activatePage?(pageId: NodeId): void;
  /** 按倍率渲染 PNG data URL（由宿主注入，工具层不碰 DOM；允许先解码图片再返回） */
  exportPng?(request: { pageId: NodeId; nodeIds?: NodeId[]; scale: number }): string | Promise<string>;
  /** 导入字体（字节内联，不收路径），返回字族/字重/风格 */
  importFont?(fileName: string, dataBase64: string): Promise<{ family: string; weight: number; style: string } | null>;
}

function serializeSubtree(store: DocStore, id: NodeId): string {
  const out: unknown[] = [];
  walkSubtree(store.doc, id, (n) =>
    out.push({
      id: n.id,
      type: n.type,
      name: n.name,
      parentId: n.parentId,
      children: n.children,
      x: n.x,
      y: n.y,
      w: n.width,
      h: n.height,
      text: n.text,
      rotation: n.rotation,
      opacity: n.opacity,
      visible: n.visible,
      locked: n.locked,
      clip: n.clip,
      style: n.style,
      ...(n.layout ? { layout: n.layout } : {}),
      ...(n.layoutSizingW ? { layoutSizingW: n.layoutSizingW } : {}),
      ...(n.layoutSizingH ? { layoutSizingH: n.layoutSizingH } : {}),
      ...(n.layoutAbsolute ? { layoutAbsolute: n.layoutAbsolute } : {}),
      ...(n.textAutoResize ? { textAutoResize: n.textAutoResize } : {}),
      ...(n.listType ? { listType: n.listType } : {}),
      ...(n.truncate ? { truncate: n.truncate } : {}),
      ...(n.type === "polygon" ? { sides: n.sides ?? 3 } : {}),
      ...(n.image ? { image: n.image } : {}),
      ...(n.vector ? { vector: n.vector } : {}),
      ...(n.componentId ? { componentId: n.componentId } : {}),
      ...(n.mainId ? { mainId: n.mainId } : {}),
      ...(n.propValues ? { propValues: n.propValues } : {}),
      ...(n.overrides ? { overrides: n.overrides } : {}),
      ...(n.slotFilled !== undefined ? { slotFilled: n.slotFilled } : {}),
      ...(n.propertyDefs ? { propertyDefs: n.propertyDefs } : {}),
    }),
  );
  return JSON.stringify(out);
}

/** 读取 points：父容器坐标，x/y 必填，手柄缺省为 0。 */
function readPoints(value: unknown): VectorAnchor[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error("points 必须是锚点数组");
  return value.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`points[${i}] 必须是对象`);
    const p = raw as Record<string, unknown>;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`points[${i}] 的 x/y 必须是数值`);
    const offset = (key: string): number => {
      const v = p[key];
      if (v === undefined) return 0;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`points[${i}].${key} 必须是数值`);
      return n;
    };
    return makeAnchor(x, y, { inX: offset("inX"), inY: offset("inY"), outX: offset("outX"), outY: offset("outY") });
  });
}

function applyStyleTokens(style: NodeStyle, args: Record<string, unknown>): void {
  // Token 优先；没有 Token 时才用字面量（设计系统由用户自己定，不强制）
  if (args.fillToken !== undefined) style.fill = { token: String(args.fillToken) };
  else if (typeof args.fill === "string") style.fill = { value: args.fill };
  if (args.strokeToken !== undefined) style.stroke = { token: String(args.strokeToken) };
  else if (typeof args.stroke === "string") style.stroke = { value: args.stroke };
  if (args.strokeWidth !== undefined) style.strokeWidth = Math.max(0, Number(args.strokeWidth));
}

export function assertToken(store: DocStore, token: string | undefined, field: string): void {
  if (token === undefined) return;
  if (!store.doc.tokens[token]) {
    throw new Error(
      `${field} 引用了不存在的 Token "${token}"；先调用 define_token 建这个 Token，或改用 fill / stroke 传字面量色值。`,
    );
  }
}

function findSlotByName(store: DocStore, instanceId: NodeId, name: string): NodeId | null {
  let found: NodeId | null = null;
  walkSubtree(store.doc, instanceId, (n) => {
    if (!found && n.type === "slot" && n.name === name) found = n.id;
  });
  return found;
}

function cornerFrom(value: unknown): CornerRadius | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return { topLeft: value, topRight: value, bottomRight: value, bottomLeft: value };
  }
  const c = value as Partial<CornerRadius>;
  return {
    topLeft: Number(c.topLeft ?? 0),
    topRight: Number(c.topRight ?? 0),
    bottomRight: Number(c.bottomRight ?? 0),
    bottomLeft: Number(c.bottomLeft ?? 0),
  };
}

function paddingFrom(value: unknown): Padding {
  if (typeof value === "number") return { top: value, right: value, bottom: value, left: value };
  const p = (value ?? {}) as Partial<Padding>;
  return { top: Number(p.top ?? 0), right: Number(p.right ?? 0), bottom: Number(p.bottom ?? 0), left: Number(p.left ?? 0) };
}

function layoutFrom(value: unknown): LayoutSpec | undefined {
  if (value === undefined) return undefined;
  const raw = value as Partial<LayoutSpec>;
  return createLayoutSpec({
    ...raw,
    padding: paddingFrom(raw.padding),
  });
}

/** 外观与排版字段（只在显式传入时覆盖）。 */
function applyStyleArgs(style: NodeStyle, args: Record<string, unknown>): NodeStyle {
  const next: NodeStyle = { ...style };
  const keys = [
    "fontFamily", "fontWeight", "fontStyle", "fontSize", "lineHeight", "lineHeightUnit",
    "letterSpacing", "letterSpacingUnit", "paragraphSpacing", "textAlign", "textVerticalAlign",
    "textCase", "textDecoration",
  ] as const;
  for (const key of keys) {
    if (args[key] !== undefined) (next as Record<string, unknown>)[key] = args[key];
  }
  const corner = cornerFrom(args.cornerRadius);
  if (corner) next.cornerRadius = corner;
  applyStyleTokens(next, args);
  if (args.effects !== undefined) next.effects = effectsFrom(args.effects);
  return next;
}

/** 效果入参 → 模型效果：颜色可以引用 Token，也可以给字面量。 */
function effectsFrom(value: unknown): Effect[] {
  if (!Array.isArray(value)) throw new Error("effects 必须是数组");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("effects 的每一项必须是对象");
    const item = raw as Record<string, unknown>;
    const type = String(item.type);
    if (type === "drop-shadow" || type === "inner-shadow") {
      const token = typeof item.fillToken === "string" ? item.fillToken : "";
      const literal = typeof item.color === "string" ? item.color : "";
      if (!token && !literal) {
        throw new Error("阴影类效果需要 fillToken 或 color（字面量色值）之一。");
      }
      return {
        type,
        visible: item.visible === undefined ? true : Boolean(item.visible),
        x: Number(item.x ?? 0),
        y: Number(item.y ?? 0),
        blur: Math.max(0, Number(item.blur ?? 0)),
        spread: Number(item.spread ?? 0),
        color: token ? { token } : { value: literal },
      } as Effect;
    }
    if (type === "layer-blur" || type === "backdrop-blur") {
      return {
        type,
        visible: item.visible === undefined ? true : Boolean(item.visible),
        radius: Math.max(0, Number(item.radius ?? 0)),
      } as Effect;
    }
    throw new Error(`未知的效果类型 "${type}"；只支持 drop-shadow / inner-shadow / layer-blur / backdrop-blur。`);
  });
}

/** 效果里的阴影颜色同样必须是已存在的 Token。 */
export function assertEffectTokens(store: DocStore, effects: Effect[] | undefined): void {
  for (const effect of effects ?? []) {
    if (effect.type === "drop-shadow" || effect.type === "inner-shadow") {
      assertToken(store, effect.color.token, "effects.fillToken");
    }
  }
}

/** 节点几何/布局字段（只在显式传入时覆盖）。 */
function applyNodeArgs(args: Record<string, unknown>): Partial<DocNode> {
  const patch: Partial<DocNode> = {};
  const keys = [
    "x", "y", "width", "height", "rotation", "opacity", "visible", "locked", "clip",
    "layoutSizingW", "layoutSizingH", "layoutMinW", "layoutMinH", "layoutMaxW", "layoutMaxH",
    "layoutAbsolute", "text", "textAutoResize", "listType", "truncate",
  ] as const;
  for (const key of keys) {
    if (args[key] !== undefined) (patch as Record<string, unknown>)[key] = args[key];
  }
  const layout = layoutFrom(args.layout);
  if (layout) patch.layout = layout;
  return patch;
}

/** 会改动文档的工具：一次调用包成一个事务，撤销时只算一步。 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "define_token",
  "rename_token",
  "delete_token",
  "create_page",
  "create_node",
  "create_instance",
  "define_property",
  "set_instance_prop",
  "fill_slot",
  "swap_instance",
  "detach_instance",
  "update_node",
  "move_node",
  "delete_node",
  "group_nodes",
  "arrange_nodes",
  "duplicate_node",
]);

/** 远程图片地址只能是 http/https；完整的网络校验（大小/超时/重定向）由主进程抓取时做。 */
function assertImageUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`图片地址不是合法的 URL：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("图片地址只支持 http/https");
  }
}

/** 报错里最多列几个节点，其余用数量收口 */
const TOKEN_REF_PREVIEW = 5;
/** 节点名截断长度：名字是用户随手起的，可能很长 */
const REF_NAME_MAX = 24;

/** 被引用时拒绝删除：给 agent 明确的下一步（detach 会冻结成什么值），并带节点名便于核对 */
function blockedDeleteMessage(doc: DocState, path: string, refs: NodeId[], value: string): string {
  const preview = refs
    .slice(0, TOKEN_REF_PREVIEW)
    .map((id) => `${(doc.nodes[id]?.name ?? "未命名").slice(0, REF_NAME_MAX)}(${id})`)
    .join("、");
  const rest = refs.length > TOKEN_REF_PREVIEW ? `，另有 ${refs.length - TOKEN_REF_PREVIEW} 个` : "";
  return (
    `Token "${path}" 仍被 ${refs.length} 个节点引用：${preview}${rest}` +
    `；传 detach=true 会把它们冻结为 ${value} 后删除（完整名单见 read_document）`
  );
}

/** 空文档没有页面：先建第一页（与人工"新建页面"同一套命令，仍在这一条事务里）。 */
function ensurePage(store: DocStore): NodeId {
  const existing = firstPageId(store.doc);
  if (existing) return existing;
  const page = createNode("page", {
    name: nextPageName(store.doc),
    x: 0,
    y: 0,
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT,
  });
  store.apply({ type: "node.create", params: { nodes: [page], parentId: null } }, "ai:page");
  return page.id;
}

export function makeExecutor(
  store: DocStore,
  getScreenshot: (region?: ScreenshotRegion) => Promise<string>,
  getActivePageId?: () => NodeId | null,
  measureText?: (node: DocNode, style: NodeStyle, text: string) => { width: number; height: number },
  documentHost?: DocumentHost,
  /** 画布当前选区（UI 状态，不进文档）；宿主不提供时 `get_selection` 返回空数组。 */
  getSelection?: () => NodeId[],
): ToolExecutor {
  return async (name, args) => {
    const run = async (): Promise<string> => {
    switch (name) {
      case "document.new": {
        if (!documentHost) throw new Error("当前宿主不支持新建文档");
        const created = await documentHost.newDocument();
        return JSON.stringify(created ? { ok: true } : { ok: false, canceled: true });
      }
      case "document.open": {
        if (!documentHost) throw new Error("当前宿主不支持打开文档");
        if ("path" in args) throw new Error("document.open 只接受系统对话框选择文件，不接受路径参数");
        const opened = await documentHost.openDocument();
        return JSON.stringify(opened ? { ok: true } : { ok: false, canceled: true });
      }
      case "read_document": {
        const pages = getPages(store.doc).map((page) => ({
          pageId: page.id,
          name: page.name,
          subtree: serializeSubtree(store, page.id),
        }));
        // 主组件是文档根节点，不在任何页面的 subtree 里：单独给一份摘要方便定位
        const withTrees = args.includeComponentTrees === true;
        const components = getRootComponents(store.doc).map((c) => ({
          componentId: c.id,
          name: c.name,
          x: c.x,
          y: c.y,
          w: c.width,
          h: c.height,
          ...(c.propertyDefs?.length
            ? { propertyDefs: c.propertyDefs.map((d) => ({ id: d.id, type: d.type, name: d.name })) }
            : {}),
          ...(withTrees ? { subtree: serializeSubtree(store, c.id) } : {}),
        }));
        return JSON.stringify({ pages, components });
      }
      case "get_selection": {
        const ids = getSelection?.() ?? [];
        const nodes = ids
          .map((id) => store.doc.nodes[id])
          .filter((node): node is DocNode => Boolean(node))
          .map((node) => {
            const box = worldRect(store.doc, node.id);
            return {
              id: node.id,
              name: node.name,
              type: node.type,
              parentId: node.parentId,
              x: Math.round((box?.x ?? 0) * 100) / 100,
              y: Math.round((box?.y ?? 0) * 100) / 100,
              width: node.width,
              height: node.height,
              locked: node.locked,
              visible: node.visible,
              // 实例指回主组件；实例子孙指回母版里对应的那个节点
              ...(node.type === "instance" ? { componentId: node.componentId } : {}),
              ...(node.mainId ? { mainId: node.mainId } : {}),
            };
          });
        return JSON.stringify({
          // 明确叫 activePageId：根级主组件被选中时它仍然指向当前页面，不代表选区所属页面
          activePageId: getActivePageId?.() ?? null,
          nodeIds: nodes.map((node) => node.id),
          nodes,
          ...(nodes.length === 0 ? { hint: "画布上没有选中对象" } : {}),
        });
      }
      case "get_tokens": {
        const tokens = store.doc.tokens;
        if (Object.keys(tokens).length === 0) {
          return JSON.stringify({
            tokens,
            hint: "当前文档没有设计系统。可以先用 define_token 建 Token，或直接用 fill / stroke 字面量。",
          });
        }
        return JSON.stringify({ tokens });
      }
      case "define_token": {
        const path = tokenPathOf(args.path);
        if (!path) {
          throw new Error(
            `Token 路径 "${String(args.path ?? "")}" 不合法：至少形如 color/primary，不能含空格或空段`,
          );
        }
        const type = args.type === "color" || args.type === "number" ? args.type : null;
        if (!type) throw new Error('type 只能是 "color" 或 "number"');
        const raw = args.value;
        const value = type === "color" ? tokenColorOf(raw) : tokenNumberOf(raw);
        if (value === null) {
          throw new Error(
            type === "color"
              ? `颜色 "${String(raw ?? "")}" 不合法：需要 #hex、rgb() 或 rgba()`
              : `数值 "${String(raw ?? "")}" 不合法`,
          );
        }
        const prev = store.doc.tokens[path];
        if (prev && prev.type !== type) {
          throw new Error(`Token "${path}" 已存在且类型为 ${prev.type}，不能改成 ${type}`);
        }
        store.apply({ type: "token.define", params: { path, tokenType: type, value } }, "ai:define_token");
        return JSON.stringify({ ok: true, path, type, value });
      }
      case "rename_token": {
        const from = tokenPathOf(args.from);
        const to = tokenPathOf(args.to);
        if (!from) throw new Error(`Token 路径 "${String(args.from ?? "")}" 不合法：至少形如 color/primary`);
        if (!to) throw new Error(`Token 路径 "${String(args.to ?? "")}" 不合法：至少形如 color/primary`);
        if (from === to) throw new Error("from 与 to 不能相同");
        if (!store.doc.tokens[from]) throw new Error(`Token "${from}" 不存在`);
        if (store.doc.tokens[to]) throw new Error(`Token "${to}" 已存在，不能重命名`);
        store.apply({ type: "token.rename", params: { from, to } }, "ai:rename_token");
        return JSON.stringify({ ok: true, from, to });
      }
      case "delete_token": {
        const path = tokenPathOf(args.path);
        if (!path) throw new Error(`Token 路径 "${String(args.path ?? "")}" 不合法：至少形如 color/primary`);

        // 宽容解析：部分客户端会把布尔写成字符串；"false" / 缺省仍按拒绝处理（安全侧不放松）
        const detach = args.detach === true || args.detach === "true";
        const plan = planTokenDelete(store.doc, path, detach);
        if (plan.status === "missing") throw new Error(`Token "${path}" 不存在`);
        if (plan.status === "blocked") throw new Error(blockedDeleteMessage(store.doc, path, plan.refs, plan.value));

        try {
          for (const cmd of plan.commands) store.apply(cmd, "ai:delete_token");
        } catch (error) {
          // 引用里含锁定节点时，core 只会说「节点「X」已锁定」：补上是谁在做哪件事
          throw new Error(
            `删除 Token "${path}" 失败：${error instanceof Error ? error.message : String(error)}` +
              "（引用含锁定节点时需先解锁）",
          );
        }
        return JSON.stringify({ ok: true, path, detached: plan.refs.length });
      }
      case "create_page": {
        const position = nextPagePosition(store.doc);
        const name = args.name === undefined ? nextPageName(store.doc) : String(args.name).trim();
        if (!name) throw new Error("页面名不能为空");
        const width = args.width === undefined ? DEFAULT_PAGE_WIDTH : Number(args.width);
        const height = args.height === undefined ? DEFAULT_PAGE_HEIGHT : Number(args.height);
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
          throw new Error("页面宽高必须是正数");
        }
        const page = createNode("page", {
          name,
          x: typeof args.x === "number" ? args.x : position.x,
          y: typeof args.y === "number" ? args.y : position.y,
          width,
          height,
        });
        store.apply({ type: "node.create", params: { nodes: [page], parentId: null } }, "ai:create_page");
        // 让后续不带 parentId 的操作默认落到新页（与左栏「+」一致）
        documentHost?.activatePage?.(page.id);
        return JSON.stringify({ ok: true, pageId: page.id, name });
      }
      case "create_node": {
        const kind = String(args.kind) as
          | "frame" | "rect" | "ellipse" | "polygon" | "line" | "path" | "text" | "image"
          | "component" | "slot";
        const isImage = kind === "image";
        const isPath = kind === "path";
        const isPolygon = kind === "polygon";
        const isComponent = kind === "component";
        const isSlot = kind === "slot";
        assertToken(store, args.fillToken as string | undefined, "fillToken");
        assertToken(store, args.strokeToken as string | undefined, "strokeToken");
        if (Array.isArray(args.effects)) assertEffectTokens(store, effectsFrom(args.effects));
        // 主组件是文档根节点（ADR-0025）：挂在哪个页面下都是错的，直接拒绝
        if (isComponent && args.parentId !== undefined && args.parentId !== null) {
          throw new Error("主组件是文档根节点，不接受 parentId");
        }
        // 空文档没有页面：先建一页再画（与人工"新建页面"同一套命令，仍是一次撤销）
        let parentId: NodeId | null = isComponent
          ? null
          : ((args.parentId as NodeId | undefined) ?? getActivePageId?.() ?? firstPageId(store.doc));
        if (!isComponent) {
          if (!parentId && args.parentId === undefined) parentId = ensurePage(store);
          if (!parentId || !store.doc.nodes[parentId]) throw new Error("parentId 不存在");
        }

        let name = args.name as string | undefined;
        if (isComponent) name = name ?? nextComponentName(store.doc);
        // 省略坐标时：主组件排到组件区末尾，其余落在父容器左上角
        const defaultPosition = isComponent ? nextComponentPosition(store.doc) : { x: 0, y: 0 };
        if (isSlot) {
          const trimmed = String(name ?? "").trim();
          if (!trimmed) throw new Error("kind=slot 必须提供唯一的 name");
          name = trimmed;
          let componentId: NodeId | null = null;
          let cur: DocNode | undefined = parentId ? store.doc.nodes[parentId] : undefined;
          while (cur) {
            if (cur.type === "instance" || cur.type === "slot") break;
            if (cur.type === "component") {
              componentId = cur.id;
              break;
            }
            cur = cur.parentId ? store.doc.nodes[cur.parentId] : undefined;
          }
          if (!componentId) throw new Error("插槽必须位于主组件内");
          let used = false;
          walkSubtree(store.doc, componentId, (n) => {
            if (n.type === "slot" && n.name === trimmed) used = true;
          });
          if (used) throw new Error(`插槽名 "${trimmed}" 已存在`);
        }

        const points = readPoints(args.points);
        const closed = Boolean(args.closed);
        if (args.sides !== undefined && !isPolygon) throw new Error("sides 仅适用于 kind=polygon");
        if (isPath) {
          if (!points) throw new Error("kind=path 必须提供 points");
          if (points.length < 2) throw new Error("路径至少需要 2 个锚点");
          if (closed && points.length < 3) throw new Error("闭合路径至少需要 3 个锚点");
          validateVector({ closed, anchors: points });
        }

        if (args.layout !== undefined && kind !== "frame" && kind !== "component") {
          throw new Error("layout 仅适用于 frame / component");
        }
        const style = applyStyleArgs({}, args);
        if (isPath) {
          // 与 GUI 一致：未显式给颜色时，闭合默认填充、开放默认描边
          if (!style.fill && !style.stroke) {
            if (closed) style.fill = { value: "#3366ff" };
            else style.stroke = { value: "#1a1a1a" };
          }
          if (style.stroke && style.strokeWidth === undefined) style.strokeWidth = 2;
        }
        if (isPolygon && !style.fill && !style.stroke) style.fill = { value: "#3366ff" };
        // 画板与 GUI 工具一致：默认白底
        if (kind === "frame" && !style.fill && !style.stroke) style.fill = { value: "#ffffff" };

        let imageRef: DocNode["image"];
        if (isImage) {
          const spec = args.image as { data?: unknown; mimeType?: unknown; url?: unknown } | undefined;
          const url = typeof spec?.url === "string" ? spec.url.trim() : "";
          const data = typeof spec?.data === "string" ? spec.data : "";
          if (url && data) throw new Error("image 的 data 与 url 只能给一个");
          if (!url && !data) {
            throw new Error("kind=image 需要 image.data（base64）或 image.url（http/https 链接）");
          }
          if (url) {
            assertImageUrl(url);
            // 链接图懒加载：尺寸未知，抓到时由渲染层用实际尺寸补齐
            imageRef = { sourceUrl: url, naturalWidth: 0, naturalHeight: 0 };
          } else {
            if (!documentHost?.addImage) throw new Error("当前宿主不支持插入图片");
            // base64 长度换算出字节数：5MB 上限，避免把一条 JSON-RPC 撑爆
            if (Math.ceil((data.length * 3) / 4) > 5 * 1024 * 1024) {
              throw new Error("图片超过 5MB 上限（GUI 拖入可到 20MB）");
            }
            const asset = await documentHost.addImage(data, String(spec?.mimeType ?? "image/png"));
            imageRef = {
              assetId: asset.assetId,
              naturalWidth: asset.width,
              naturalHeight: asset.height,
              crop: { x: 0, y: 0, width: asset.width, height: asset.height },
            };
          }
        }

        const node = createNode(kind, {
          name: name ?? (isPolygon ? (clampSides(args.sides as number) === 3 ? "三角形" : "多边形") : kind),
          // 路径的 points 是父容器坐标：先放在 0,0，由 store 归一化并推导节点框
          x: isPath ? 0 : ((args.x as number) ?? defaultPosition.x),
          y: isPath ? 0 : ((args.y as number) ?? defaultPosition.y),
          width: isPath ? 1 : ((args.width as number) ?? (imageRef?.naturalWidth || 100)),
          height: isPath ? 1 : ((args.height as number) ?? (imageRef?.naturalHeight || 100)),
          text: args.text as string | undefined,
          vector: isPath ? { closed, anchors: points! } : undefined,
          sides: isPolygon ? clampSides(args.sides as number) : undefined,
          image: imageRef,
          style,
          ...applyNodeArgs(args),
        });
        // 与 GUI 一致：新建画板 / 组件默认开启自动布局（AI 显式给了 layout 则以其为准）
        if ((kind === "frame" || kind === "component") && !node.layout) node.layout = defaultLayoutFor(kind);
        // 文本：自动尺寸由宿主注入的测量函数决定
        if (kind === "text" && measureText && (node.textAutoResize ?? "auto-width") !== "fixed") {
          const size = measureText(node, node.style, node.text ?? "");
          node.width = size.width;
          node.height = size.height;
        }
        store.apply({ type: "node.create", params: { nodes: [node], parentId } }, "ai:create");
        return JSON.stringify({ ok: true, nodeId: node.id });
      }
      case "create_instance": {
        const componentId = String(args.componentId);
        const master = store.doc.nodes[componentId];
        if (!master || master.type !== "component") throw new Error(`组件 ${componentId} 不存在`);
        // 空文档没有页面：先建一页再画（与人工"新建页面"同一套命令，仍是一次撤销）
        let parentId = (args.parentId as NodeId | undefined) ?? getActivePageId?.() ?? firstPageId(store.doc);
        if (!parentId && args.parentId === undefined) parentId = ensurePage(store);
        if (!parentId || !store.doc.nodes[parentId]) throw new Error("parentId 不存在");
        const nodeId = newId();
        store.apply(
          {
            type: "instance.create",
            params: {
              componentId,
              parentId,
              nodeId,
              x: Number(args.x ?? 0),
              y: Number(args.y ?? 0),
              name: args.name as string | undefined,
            },
          },
          "ai:instance",
        );
        return JSON.stringify({ ok: true, nodeId });
      }
      case "define_property": {
        const componentId = String(args.componentId);
        const targetNodeId = String(args.targetNodeId);
        const type = String(args.type);
        if (type !== "text" && type !== "boolean" && type !== "instance") {
          throw new Error("type 必须是 text / boolean / instance");
        }
        const id = newId();
        store.apply(
          {
            type: "property.define",
            params: {
              componentId,
              targetMainId: targetNodeId,
              id,
              type,
              name: args.name as string | undefined,
            },
          },
          "ai:property",
        );
        const def = store.doc.nodes[componentId]?.propertyDefs?.find((d) => d.id === id);
        return JSON.stringify({ ok: true, propertyId: id, name: def?.name });
      }
      case "set_instance_prop": {
        const instanceId = String(args.instanceId);
        const propertyId = String(args.propertyId);
        const value = args.value === undefined ? null : (args.value as string | boolean | null);
        store.apply(
          { type: "property.set", params: { instanceId, propertyId, value } },
          "ai:property",
        );
        return JSON.stringify({ ok: true });
      }
      case "fill_slot": {
        const instanceId = String(args.instanceId);
        const slotName = String(args.slotName);
        const slotId = findSlotByName(store, instanceId, slotName);
        if (!slotId) throw new Error(`实例里没有名为 "${slotName}" 的插槽`);
        const nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : [];
        if (nodeIds.length === 0) throw new Error("nodeIds 不能为空");
        store.apply({ type: "slot.fill", params: { slotId, nodeIds } }, "ai:slot");
        return JSON.stringify({ ok: true, slotId });
      }
      case "swap_instance": {
        const instanceId = String(args.instanceId);
        const componentId = String(args.componentId);
        store.apply({ type: "instance.swap", params: { instanceId, componentId } }, "ai:swap");
        return JSON.stringify({ ok: true });
      }
      case "detach_instance": {
        const instanceId = String(args.instanceId);
        store.apply({ type: "component.detach", params: { instanceId } }, "ai:detach");
        return JSON.stringify({ ok: true });
      }
      case "update_node": {
        const nodeId = args.nodeId as NodeId;
        const node = store.doc.nodes[nodeId];
        if (!node) throw new Error(`节点 ${nodeId} 不存在`);
        assertToken(store, args.fillToken as string | undefined, "fillToken");
        assertToken(store, args.strokeToken as string | undefined, "strokeToken");
        if (Array.isArray(args.effects)) assertEffectTokens(store, effectsFrom(args.effects));

        if (args.layout !== undefined && node.type !== "frame" && node.type !== "component" && node.type !== "instance") {
          throw new Error("layout 仅适用于 frame / component / instance");
        }
        const patch: Partial<DocNode> = { ...applyNodeArgs(args) };
        if (args.name !== undefined) {
          const name = String(args.name).trim();
          if (!name) throw new Error("name 不能为空");
          patch.name = name;
        }

        if (args.backgroundImage !== undefined) {
          if (node.type !== "page") throw new Error("backgroundImage 仅适用于页面");
          const spec = args.backgroundImage as
            | { data?: string; mimeType?: string; assetId?: string; fit?: "cover" | "contain" | "tile" }
            | null;
          if (spec === null) {
            patch.backgroundImage = undefined;
          } else if (spec?.assetId) {
            // 尺寸由解码后的位图决定，不在模型里写伪值
            patch.backgroundImage = { assetId: spec.assetId, fit: spec.fit ?? "cover" };
          } else if (spec?.data) {
            if (!documentHost?.addImage) throw new Error("当前宿主不支持图片");
            if (Math.ceil((spec.data.length * 3) / 4) > 5 * 1024 * 1024) {
              throw new Error("背景图超过 5MB 上限");
            }
            const asset = await documentHost.addImage(spec.data, String(spec.mimeType ?? "image/png"));
            patch.backgroundImage = {
              assetId: asset.assetId,
              naturalWidth: asset.width,
              naturalHeight: asset.height,
              fit: spec.fit ?? "cover",
            };
          } else {
            throw new Error("backgroundImage 需要 data 或 assetId");
          }
        }

        const style = applyStyleArgs(node.style, args);
        if (JSON.stringify(style) !== JSON.stringify(node.style)) patch.style = style;

        if (args.mask !== undefined) patch.isMask = Boolean(args.mask);
        if (args.crop !== undefined) {
          if (node.type !== "image" || !node.image) throw new Error("crop 仅适用于图片节点");
          if (!(node.image.naturalWidth > 0) || !(node.image.naturalHeight > 0)) {
            throw new Error("这张链接图还没加载完，暂时无法裁切；先让它显示出来再改 crop");
          }
          const raw = args.crop as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
          const current = node.image.crop ?? {
            x: 0,
            y: 0,
            width: node.image.naturalWidth,
            height: node.image.naturalHeight,
          };
          patch.image = {
            ...node.image,
            crop: {
              x: Number(raw.x ?? current.x),
              y: Number(raw.y ?? current.y),
              width: Number(raw.width ?? current.width),
              height: Number(raw.height ?? current.height),
            },
          };
        }
        // 放在 crop 之后：换源会整体替换 image（裁切与尺寸都作废），不能被上一步覆盖回去
        if (args.imageUrl !== undefined) {
          if (node.type !== "image") throw new Error("imageUrl 仅适用于图片节点");
          const raw = typeof args.imageUrl === "string" ? args.imageUrl.trim() : "";
          if (!raw) throw new Error("imageUrl 不能为空");
          assertImageUrl(raw);
          // 换源：尺寸与原图裁切都作废，抓到后由渲染层按实际尺寸铺满
          patch.image = { sourceUrl: raw, naturalWidth: 0, naturalHeight: 0 };
        }

        const points = readPoints(args.points);
        const closedArg = args.closed !== undefined ? Boolean(args.closed) : undefined;
        if (args.sides !== undefined) {
          if (node.type !== "polygon") throw new Error("sides 仅适用于 polygon 节点");
          patch.sides = clampSides(Number(args.sides));
        }
        if (points) {
          if (node.type !== "path") throw new Error("points 仅适用于 path 节点");
          if (points.length < 2) throw new Error("路径至少需要 2 个锚点");
          const anchors = points.map((p) => ({ ...p, x: p.x - node.x, y: p.y - node.y }));
          patch.vector = { closed: closedArg ?? node.vector?.closed ?? false, anchors };
        } else if (closedArg !== undefined) {
          if (!node.vector) throw new Error("closed 仅适用于 path 节点");
          patch.vector = { ...node.vector, closed: closedArg };
        }

        // 文本自动尺寸：文本或排版变化后重算
        if (node.type === "text" && measureText) {
          const mode = (patch.textAutoResize ?? node.textAutoResize ?? "auto-width") as TextAutoResize;
          const text = (patch.text ?? node.text ?? "") as string;
          const style = (patch.style ?? node.style) as NodeStyle;
          if (mode !== "fixed") {
            const size = measureText({ ...node, ...patch, style }, style, text);
            if (mode === "auto-width") patch.width = size.width;
            patch.height = size.height;
          }
        }
        store.apply({ type: "node.update", params: { nodeId, patch } }, "ai:update");
        return JSON.stringify({ ok: true });
      }
      case "move_node": {
        const nodeId = String(args.nodeId);
        const parentId = String(args.parentId);
        const node = store.doc.nodes[nodeId];
        if (!node) throw new Error(`节点 ${nodeId} 不存在`);
        const parent = store.doc.nodes[parentId];
        if (!parent) throw new Error(`父节点 ${parentId} 不存在`);
        if (node.type === "component") throw new Error("主组件固定在文档根节点，不能移动父级");
        const world = worldRect(store.doc, nodeId);
        const parentWorld = worldRect(store.doc, parentId);
        if (!world || !parentWorld) throw new Error("节点或父节点没有几何信息");
        // 进流与否跟画布拖动一致：自动布局容器默认进流，absolute 保留绝对定位
        const inFlow = Boolean(parent.layout) && args.absolute !== true;
        const commands: Command[] = [
          {
            type: "node.reparent",
            params: {
              nodeId,
              parentId,
              x: world.x - parentWorld.x,
              y: world.y - parentWorld.y,
              ...(inFlow ? { index: typeof args.index === "number" ? args.index : parent.children.length } : {}),
            },
          },
        ];
        if (parent.layout) {
          const wantAbsolute = !inFlow;
          if (Boolean(node.layoutAbsolute) !== wantAbsolute) {
            commands.push({ type: "node.update", params: { nodeId, patch: { layoutAbsolute: wantAbsolute } } });
          }
        }
        store.apply(commands, "ai:move");
        return JSON.stringify({ ok: true, nodeId, parentId, inFlow });
      }
      case "delete_node": {
        const nodeId = args.nodeId as NodeId;
        if (!store.doc.nodes[nodeId]) throw new Error(`节点 ${nodeId} 不存在`);
        store.apply({ type: "node.delete", params: { nodeId } }, "ai:delete");
        return JSON.stringify({ ok: true });
      }
      case "group_nodes": {
        const nodeIds = args.nodeIds as NodeId[];
        if (!Array.isArray(nodeIds) || nodeIds.length === 0) throw new Error("group_nodes 需要 nodeIds");
        const groupId = newId();
        store.apply(
          { type: "node.group", params: { nodeIds, groupId, name: args.name as string | undefined } },
          "ai:group",
        );
        return JSON.stringify({ ok: true, groupId });
      }
      case "arrange_nodes": {
        const nodeIds = args.nodeIds as NodeId[];
        if (!Array.isArray(nodeIds) || nodeIds.length === 0) throw new Error("arrange_nodes 需要 nodeIds");
        const action = String(args.action ?? "");
        const ALIGN: Record<string, AlignEdge> = {
          "align-left": "left",
          "align-h-center": "h-center",
          "align-right": "right",
          "align-top": "top",
          "align-v-center": "v-center",
          "align-bottom": "bottom",
        };
        const DISTRIBUTE: Record<string, DistributeAxis> = {
          "distribute-h": "horizontal",
          "distribute-v": "vertical",
        };
        const REORDER: Record<string, ReorderAction> = {
          "bring-forward": "forward",
          "send-backward": "backward",
          "bring-to-front": "front",
          "send-to-back": "back",
        };
        if (ALIGN[action]) {
          store.apply({ type: "node.align", params: { nodeIds, align: ALIGN[action] } }, "ai:align");
        } else if (DISTRIBUTE[action]) {
          store.apply({ type: "node.distribute", params: { nodeIds, axis: DISTRIBUTE[action] } }, "ai:distribute");
        } else if (REORDER[action]) {
          store.apply({ type: "node.reorder", params: { nodeIds, action: REORDER[action] } }, "ai:reorder");
        } else {
          throw new Error(`arrange_nodes 不支持的动作: ${action}`);
        }
        return JSON.stringify({ ok: true });
      }
      case "duplicate_node": {
        const nodeId = args.nodeId as NodeId;
        if (!store.doc.nodes[nodeId]) throw new Error(`节点 ${nodeId} 不存在`);
        const plan = planDuplicate(store.doc, [nodeId], {
          dx: typeof args.offsetX === "number" ? args.offsetX : 10,
          dy: typeof args.offsetY === "number" ? args.offsetY : 10,
          makeId: newId,
        });
        store.apply(plan.command, "ai:duplicate");
        return JSON.stringify({ ok: true, nodeIds: plan.rootIds });
      }
      case "import_font": {
        if (!documentHost?.importFont) throw new Error("当前宿主不支持导入字体");
        const fileName = String(args.fileName ?? "font");
        const data = String(args.dataBase64 ?? "");
        if (!data) throw new Error("import_font 需要 dataBase64");
        if (Math.ceil((data.length * 3) / 4) > 5 * 1024 * 1024) throw new Error("字体超过 5MB 上限");
        const meta = await documentHost.importFont(fileName, data);
        if (!meta) throw new Error("字体导入失败：格式不支持或已损坏");
        return JSON.stringify({ ok: true, ...meta });
      }
      case "inspect_layout": {
        const pageId = (args.pageId as NodeId | undefined) ?? getActivePageId?.() ?? firstPageId(store.doc);
        const page = pageId ? store.doc.nodes[pageId] : null;
        if (!page || page.type !== "page") throw new Error("pageId 不存在或不是页面");
        // nodeIds 是"根"：每棵都含整棵子树。被另一个 id 包含的后代去掉，避免重复输出。
        const only = Array.isArray(args.nodeIds) ? new Set(args.nodeIds as NodeId[]) : null;
        let roots: NodeId[];
        if (only) {
          roots = [...only].filter((id) => {
            if (!store.doc.nodes[id]) return false;
            let cur = store.doc.nodes[id];
            while (cur?.parentId) {
              if (only.has(cur.parentId)) return false;
              cur = store.doc.nodes[cur.parentId];
            }
            return true;
          });
        } else {
          roots = [...page.children];
        }
        const rows: unknown[] = [];
        const emitted = new Set<NodeId>();
        const visit = (id: NodeId, depth: number) => {
          const node = store.doc.nodes[id];
          if (!node || emitted.has(id)) return;
          emitted.add(id);
          const box = worldRect(store.doc, id);
          rows.push({
            id: node.id,
            name: node.name,
            type: node.type,
            depth,
            x: Math.round((box?.x ?? 0) * 100) / 100,
            y: Math.round((box?.y ?? 0) * 100) / 100,
            width: node.width,
            height: node.height,
            absolute: Boolean(node.layoutAbsolute),
            sizingW: node.layoutSizingW,
            sizingH: node.layoutSizingH,
            layout: node.layout ?? null,
          });
          for (const childId of node.children) visit(childId, depth + 1);
        };
        for (const rootId of roots) visit(rootId, 0);
        return JSON.stringify({ pageId: page.id, nodes: rows });
      }
      case "export_png": {
        if (!documentHost?.exportPng) throw new Error("当前宿主不支持导出 PNG");
        const pageId = (args.pageId as NodeId | undefined) ?? getActivePageId?.() ?? firstPageId(store.doc);
        if (!pageId || !store.doc.nodes[pageId]) throw new Error("pageId 不存在");
        const nodeIds = Array.isArray(args.nodeIds) ? (args.nodeIds as NodeId[]) : undefined;
        const scale = typeof args.scale === "number" ? args.scale : 2;
        if (!(scale > 0 && scale <= 4)) throw new Error("scale 需要在 (0, 4] 之间");
        const image = await documentHost.exportPng({ pageId, nodeIds, scale });
        if (!image) throw new Error("导出失败：没有可导出的内容");
        return JSON.stringify({ ok: true, image });
      }
      case "screenshot": {
        const region = args.region as ScreenshotRegion | undefined;
        if (region) {
          const valid =
            Number.isFinite(region.x) &&
            Number.isFinite(region.y) &&
            Number.isFinite(region.width) &&
            Number.isFinite(region.height) &&
            region.width > 0 &&
            region.height > 0;
          if (!valid) throw new Error("screenshot.region 需要 x/y/width/height，且宽高为正数");
        }
        return JSON.stringify({ ok: true, image: await getScreenshot(region) });
      }
      default:
        throw new Error(`未知工具: ${name}`);
    }
    };
    return MUTATING_TOOLS.has(name) ? store.transact(`MCP：${name}`, run) : run();
  };
}

/** 供 OpenAI 兼容接口使用的 tools 字段格式。 */
export function toOpenAITools(): Array<{ type: "function"; function: ToolDefinition }> {
  return tools.map((t) => ({ type: "function" as const, function: t }));
}

/** 供 MCP Server 使用的扁平清单（骨架；M4 正式实现挂 @modelcontextprotocol/sdk）。 */
export function toMCPManifest(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
}

export type { Command };
