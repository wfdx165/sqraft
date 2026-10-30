#!/usr/bin/env node
/**
 * Sqraft MCP 薄客户端。
 *
 * 职责只有三件：连本机 IPC → 把 stdio 与它双向管道 → 应用没在跑就先拉起来。
 * agent 杀掉本进程只会死掉这条管道，Sqraft 与未保存的文档不受影响。
 *
 * 端点规则与 apps/desktop/src/main/mcp/endpoint.ts 必须保持一致。
 */
"use strict";

const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROTOCOL = 1;
const CONNECT_TIMEOUT_MS = 20000;
const HELLO_TIMEOUT_MS = 5000;
const PIPE_NAME = "\\\\.\\pipe\\sqraft-mcp";

function userDataDir() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "Sqraft");
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Sqraft");
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Sqraft");
}

function endpoint() {
  return process.platform === "win32" ? PIPE_NAME : path.join(userDataDir(), "mcp.sock");
}

function appExecutable() {
  if (process.env.SQRAFT_APP_PATH) return process.env.SQRAFT_APP_PATH;
  if (process.platform === "darwin") return path.resolve(__dirname, "../../MacOS/Sqraft");
  if (process.platform === "win32") return path.resolve(__dirname, "../../Sqraft.exe");
  return path.resolve(__dirname, "../../sqraft");
}

function log(message) {
  process.stderr.write(`[sqraft-mcp] ${message}\n`);
}

function tryConnect() {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint());
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

async function connectOrLaunch() {
  const existing = await tryConnect();
  if (existing) return existing;

  const executable = appExecutable();
  // 开发态用 SQRAFT_APP_PATH 指向 electron 二进制，SQRAFT_APP_ARGS 传项目目录
  const args = process.env.SQRAFT_APP_ARGS ? process.env.SQRAFT_APP_ARGS.split(" ").filter(Boolean) : [];
  log(`应用未运行，正在启动：${executable}`);
  try {
    const child = spawn(executable, [...args, "--mcp"], { detached: true, stdio: "ignore" });
    child.on("error", (error) => log(`启动出错：${String(error)}`));
    child.unref();
  } catch (error) {
    log(`启动失败：${String(error)}`);
  }

  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const socket = await tryConnect();
    if (socket) return socket;
  }
  return null;
}

function handshake(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("握手超时：Sqraft 没有响应"));
    }, HELLO_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
    }

    function onClose() {
      cleanup();
      reject(new Error("连接在握手前关闭"));
    }

    function onData(chunk) {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      const rest = buffer.slice(newline + 1);
      cleanup();
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        reject(new Error("无法解析握手响应"));
        return;
      }
      if (message.type === "hello-error") {
        reject(new Error(message.message || "协议不兼容"));
        return;
      }
      if (message.type !== "hello-ok") {
        reject(new Error("意外的握手响应"));
        return;
      }
      if (message.protocol !== PROTOCOL) {
        reject(new Error(`协议版本不兼容：应用 ${message.protocol}，客户端 ${PROTOCOL}`));
        return;
      }
      resolve(rest);
    }

    socket.on("data", onData);
    socket.on("close", onClose);
    socket.write(`${JSON.stringify({ type: "hello", protocol: PROTOCOL })}\n`);
  });
}

async function main() {
  const socket = await connectOrLaunch();
  if (!socket) {
    log("无法连接 Sqraft：应用启动失败或端点不可用");
    process.exit(1);
  }

  let leftover;
  try {
    leftover = await handshake(socket);
  } catch (error) {
    log(String(error.message || error));
    socket.destroy();
    process.exit(1);
  }

  if (leftover) process.stdout.write(leftover);
  socket.on("data", (chunk) => process.stdout.write(chunk));
  socket.on("close", () => process.exit(0));
  socket.on("error", (error) => {
    log(`连接错误：${String(error)}`);
    process.exit(1);
  });

  process.stdin.pipe(socket);
  process.stdin.on("end", () => socket.end());

  const stop = () => {
    socket.destroy();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  log(String(error));
  process.exit(1);
});
