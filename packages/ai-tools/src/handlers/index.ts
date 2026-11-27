// 工具名 → 处理函数；tools.ts 与这里要一起改。
import * as components from "./components";
import * as document from "./document";
import * as nodes from "./nodes";
import * as booleanOps from "./boolean";
import * as pages from "./pages";
import * as read from "./read";
import * as tokens from "./tokens";
import * as view from "./view";
import type { Handler } from "../types";

export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "define_token",
  "rename_token",
  "delete_token",
  "create_page",
  "create_node",
  "create_nodes",
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
  "boolean_op",
  "convert_to_path",
  "set_interaction",
  "remove_interaction",
  "import_svg",
]);

export const handlers: Record<string, Handler> = {
  "app_state": document.handleAppState,
  "app_info": document.handleAppInfo,
  "read_document": read.handleReadDocument,
  "search_nodes": read.handleSearchNodes,
  "get_selection": read.handleGetSelection,
  "set_interaction": pages.handleSetInteraction,
  "remove_interaction": pages.handleRemoveInteraction,
  "list_interactions": pages.handleListInteractions,
  "get_tokens": tokens.handleGetTokens,
  "define_token": tokens.handleDefineToken,
  "rename_token": tokens.handleRenameToken,
  "delete_token": tokens.handleDeleteToken,
  "create_page": pages.handleCreatePage,
  "create_node": nodes.handleCreateNode,
  "create_nodes": nodes.handleCreateNodes,
  "create_instance": components.handleCreateInstance,
  "create_component_set": components.handleCreateComponentSet,
  "add_variant": components.handleAddVariant,
  "define_property": components.handleDefineProperty,
  "set_instance_prop": components.handleSetInstanceProp,
  "fill_slot": components.handleFillSlot,
  "swap_instance": components.handleSwapInstance,
  "detach_instance": components.handleDetachInstance,
  "update_node": nodes.handleUpdateNode,
  "move_node": nodes.handleMoveNode,
  "delete_node": nodes.handleDeleteNode,
  "group_nodes": nodes.handleGroupNodes,
  "arrange_nodes": nodes.handleArrangeNodes,
  "duplicate_node": nodes.handleDuplicateNode,
  "boolean_op": booleanOps.handleBooleanOp,
  "convert_to_path": booleanOps.handleConvertToPath,
  "import_font": document.handleImportFont,
  "inspect_layout": read.handleInspectLayout,
  "export_as": view.handleExportAs,
  "import_svg": view.handleImportSvg,
  "screenshot": view.handleScreenshot,
};
