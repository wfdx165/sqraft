/**
 * MCP 端口的唯一定义点：服务端监听、偏好校验、界面提示都从这里取。
 *
 * 端口范围避开特权端口；默认 7331 是"配置一次长期有效"的约定值。
 */
export const MCP_DEFAULT_PORT = 7331;
export const MCP_MIN_PORT = 1024;
export const MCP_MAX_PORT = 65535;
/** 自动模式端口被占时向上尝试的次数；显式端口为 0（不漂移）。 */
export const MCP_FALLBACK_STEPS = 20;

/** 端口必须是 1024–65535 的整数。 */
export function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MCP_MIN_PORT && value <= MCP_MAX_PORT;
}
