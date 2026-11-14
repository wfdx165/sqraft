/**
 * 工具清单（MCP `tools/list` 的唯一真源）：JSON Schema + 描述。
 * 执行器在 handlers/ 下按工具名分派；两边要一起改。
 */
import { NODE_TYPES } from "@sqraft/core";


/** search_nodes 的 type 过滤白名单：直接取 core 的运行时类型表，新增类型不会漏。 */
export const SEARCH_TYPES: ReadonlySet<string> = new Set(NODE_TYPES);

/** create_node / update_node 共用的排版与外观字段。 */
const STYLE_SCHEMA: Record<string, unknown> = {
  fillToken: { type: "string", description: "填充色的 Token 名，如 color/primary；与 fill 二选一，Token 优先" },
  fill: { type: "string", description: "填充色的字面量（如 #3366ff）；没有设计系统时直接给色值" },
  strokeToken: { type: "string", description: "描边色的 Token 名；与 stroke 二选一，Token 优先" },
  stroke: { type: "string", description: "描边色的字面量（如 #1a1a1a）" },
  strokeWidth: { type: "number", description: "描边线宽" },
  fontSizeToken: { type: "string", description: "字号的数值 Token 名，如 size/body；与 fontSize 同时存在时 Token 优先" },
  lineHeightToken: { type: "string", description: "行高的数值 Token 名；绑定后行高单位若为 auto 会自动切到 px" },
  letterSpacingToken: { type: "string", description: "字距的数值 Token 名" },
  paragraphSpacingToken: { type: "string", description: "段距的数值 Token 名" },
  strokeWidthToken: { type: "string", description: "描边线宽的数值 Token 名" },
  cornerRadiusTokens: {
    type: "object",
    description: "逐角绑定数值 Token；null 表示解绑该角，省略则保持原绑定",
    properties: {
      topLeft: { oneOf: [{ type: "string" }, { type: "null" }] },
      topRight: { oneOf: [{ type: "string" }, { type: "null" }] },
      bottomRight: { oneOf: [{ type: "string" }, { type: "null" }] },
      bottomLeft: { oneOf: [{ type: "string" }, { type: "null" }] },
    },
    additionalProperties: false,
  },
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
      gapToken: { type: "string", description: "间距的数值 Token 名" },
      crossGapToken: { type: "string", description: "换行行距的数值 Token 名" },
      paddingTokens: {
        type: "object",
        description: "逐边绑定内边距数值 Token；null 表示解绑该边，省略则保持原绑定",
        properties: {
          top: { oneOf: [{ type: "string" }, { type: "null" }] },
          right: { oneOf: [{ type: "string" }, { type: "null" }] },
          bottom: { oneOf: [{ type: "string" }, { type: "null" }] },
          left: { oneOf: [{ type: "string" }, { type: "null" }] },
        },
        additionalProperties: false,
      },
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
      "读取文档的一段：默认只读当前页的一层（scope=page、depth=1），大稿不要整篇读。用 scope=subtree + subtreeId 读任意子树（页面、画板、分组、组件母版、实例内节点都行）；scope=document 只给页面与组件摘要（nodeCount / tokenCount）。nodes 是先序扁平数组，每条带相对 depth；到 limit 停下时 truncated=true 并给 hint。组件是文档根节点、不在页面树里：看母版内部用 scope=subtree，不要再用 includeComponentTrees（已弃用）。实例带 componentId / propValues / overrides，插槽带 slotFilled；样式里的 fontSize / gap / padding 等是 Token 缺失时的回退字面量，实际值看对应的 *Token 与 get_tokens。返回 JSON 字符串。",
    readonly: true,
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["page", "subtree", "document"],
          description: "page=读一个页面（默认）；subtree=读任意节点子树；document=只给页面与组件摘要",
        },
        pageId: { type: "string", description: "scope=page 时读哪个页面，缺省为当前活动页" },
        subtreeId: { type: "string", description: "scope=subtree 时的根节点 id（含自身）" },
        depth: {
          type: "number",
          description: "从作用域根往下走几层，0–8，默认 1（只含直接子节点）；越界夹紧",
        },
        limit: { type: "number", description: "最多返回多少节点，1–1000，默认 200；越界夹紧" },
        includeComponentTrees: {
          type: "boolean",
          description: "已弃用：不再展开母版子树，改用 scope=subtree + subtreeId",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_nodes",
    description:
      "按条件在文档里找节点，返回轻量命中行：id / name / type / parentId / rootKind / rootId / path（名称链）/ match（field + snippet）。不返回子树、不带坐标——要看内容再用 read_document({scope:\"subtree\", subtreeId:<hit id>})。所有条件之间是 AND，至少给一个：name / text 是大小写不敏感子串，type / fillToken / strokeToken / componentId 是精确匹配（type 可给数组）。默认搜所有页面与组件母版（visible:false 的节点连同子树跳过，includeHidden=true 才包含）；pageId 限定单页。命中到 limit 即停，hasMore 表示还有更多。返回 JSON 字符串。",
    readonly: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "节点名，大小写不敏感子串" },
        text: { type: "string", description: "文本节点的内容，大小写不敏感子串" },
        type: {
          description: "节点类型，精确匹配；可以给一个字符串或类型数组",
          oneOf: [
            { type: "string", enum: [...SEARCH_TYPES] },
            { type: "array", items: { type: "string", enum: [...SEARCH_TYPES] } },
          ],
        },
        fillToken: { type: "string", description: "填充 Token 的完整 path，精确匹配，如 color/primary" },
        strokeToken: { type: "string", description: "描边 Token 的完整 path，精确匹配" },
        componentId: { type: "string", description: "实例引用的母版 id，或母版自身的节点 id" },
        pageId: { type: "string", description: "只在某个页面里搜；缺省搜所有页面 + 组件母版" },
        includeHidden: { type: "boolean", description: "是否包含 visible:false 的节点，默认 false" },
        limit: { type: "number", description: "最多返回多少条命中，1–200，默认 20；越界夹紧" },
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
    name: "set_interaction",
    description:
      "给页面里的图层设置一条「点击后」原型链接（演示模式里生效）：action=navigate 跳到 targetPageId，action=back 返回上一屏。只改写该图层的第一条点击交互，其余交互保持不动；一次调用 = 一个撤销步。热区必须在页面子树里（主组件、实例内部的图层不能挂链接），目标必须是页面，且不能是自己所在的页面。",
    input_schema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "热区图层 id，必须位于页面里" },
        action: {
          type: "string",
          enum: ["navigate", "back"],
          description: "navigate = 跳到目标页面；back = 返回上一屏（出栈）",
        },
        targetPageId: { type: "string", description: "目标页面 id；action=back 时不要传" },
        transition: {
          type: "string",
          enum: ["instant", "dissolve"],
          description: "转场方式：instant 瞬间切换，dissolve 淡入；默认 dissolve",
        },
        durationMs: { type: "number", description: "淡入时长（60–2000 毫秒）；instant 时忽略" },
      },
      required: ["nodeId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_interaction",
    description: "移除图层上的全部点击交互（可撤销）。",
    input_schema: {
      type: "object",
      properties: { nodeId: { type: "string" } },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_interactions",
    description:
      "列出文档里所有原型链接：每条带热区节点、所在页面、目标页面（或 back）、转场与时长；同时给出每个页面的滚动方向（none / vertical / horizontal）。只读。",
    readonly: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "app_info",
    description:
      "读取当前 Sqraft 应用的只读元信息：应用名、版本、文件格式版本、运行平台。排障第一步——确认 agent 连的是哪个版本，再决定是不是版本太旧导致工具行为不一致。",
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
      "新增或覆盖一个设计 Token。path 形如 color/primary、spacing/md（至少含一个 /，不能有空格或空段）；type=color 时 value 接受 #hex（3/6/8 位）、rgb() / rgba()（带 alpha 也可用 8 位 hex），type=number 时接受有限数值。已存在的同类型路径覆盖取值（可撤销）；不能把已有 Token 改成另一种类型。数值 Token 可被 fontSizeToken / lineHeightToken / letterSpacingToken / paragraphSpacingToken / strokeWidthToken / cornerRadiusTokens / gapToken / crossGapToken / paddingTokens 引用。",
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
      "重命名设计 Token；节点里对旧路径的 fill / stroke / 阴影颜色引用会一起改过去，数值引用（*Token）也会同步（可撤销）。旧路径不存在或目标路径已存在时拒绝。",
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
      "在父节点下创建一个节点。kind 支持 frame/rect/ellipse/polygon/line/path/text/image/component/slot。component 是文档根节点（不接受 parentId；x/y 省略时自动排到画布上的组件区）；slot 必须位于主组件内并提供唯一名字。polygon 是参数化多边形，用 sides 指定边数（3–12，默认 3，3 即三角形），顶点由 width/height 包围盒推导。path 用 points 描述锚点（父容器坐标，手柄为相对锚点的偏移），闭合路径至少 3 个锚点、开放路径至少 2 个。image 用 image.data 传 base64（上限 5MB），不接受文件路径。颜色可引用 fillToken / strokeToken，也可直接给 fill / stroke 字面量（Token 优先）。数值属性可引用 fontSizeToken / lineHeightToken / letterSpacingToken / paragraphSpacingToken / strokeWidthToken / cornerRadiusTokens / layout.gapToken / layout.crossGapToken / layout.paddingTokens（与字面量同时存在时 Token 优先）。",
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
      "更新节点属性（含改名）。颜色可引用 fillToken / strokeToken，也可给 fill / stroke 字面量（Token 优先）。数值属性可引用 fontSizeToken / lineHeightToken / letterSpacingToken / paragraphSpacingToken / strokeWidthToken / cornerRadiusTokens / layout.gapToken / layout.crossGapToken / layout.paddingTokens；cornerRadiusTokens / paddingTokens 传 null 可解绑单个角/边。只传字面量（如 fontSize / gap / padding）会自动解绑对应 Token。polygon 可用 sides 改边数（3–12）。path 可用 points（父容器坐标）整体替换锚点、用 closed 切换闭合；只改 width/height 时锚点会按比例缩放。图片节点可用 crop 改可见区域（原图像素坐标）、用 mask 标记为蒙版（遮罩同父级上方相邻兄弟）。",
    input_schema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        name: { type: "string", description: "新名字；页面 / 图层 / 组件都可改" },
        text: { type: "string" },
        sides: { type: "number", description: "polygon 的边数，3–12" },
        closed: { type: "boolean" },
        scrollDirection: {
          type: "string",
          enum: ["none", "vertical", "horizontal"],
          description: "页面在演示模式里的滚动方向（仅 page）；none = 不滚动",
        },
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
      "读取页面或指定节点的布局数据：世界坐标几何、是否绝对定位、自动布局参数（方向/gap/padding/wrap）与 hug-fill 行为；布局对象会带 gapToken / crossGapToken / paddingTokens 引用，存在 Token 时 `resolved` 给出解析后的实际 gap / crossGap / padding。同时返回 `diagnostics`：对这一批节点跑与写工具同一套规则（ZERO_SIZE / TEXT_NO_FILL / TEXT_OVERFLOW / TOKEN_MISSING / OUTSIDE_PARENT），描述的是当前状态。只读。",
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
      "截取当前画布视口为 PNG（data URL），用于自检生成结果。只包含设计稿本身（不含网格、选中框、参考线）。可用 region 只截文档坐标下的某个范围，例如某个画板。看不出图片的客户端用 format=\"text\"：返回区域内节点的几何、解析后的填充/描边颜色、文字与同一套诊断（最多 200 个节点），region 省略时取当前页页面框。",
    readonly: true,
    input_schema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["image", "text"],
          description: "image=PNG（默认）；text=纯文本替代视图，给看不出图片的客户端",
        },
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
