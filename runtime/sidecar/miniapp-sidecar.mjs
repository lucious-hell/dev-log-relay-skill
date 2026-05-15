import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

const port = Number(process.env.DEV_LOG_RELAY_MINIAPP_SIDECAR_PORT || 5078);
const relayHome = path.resolve(process.env.DEV_LOG_RELAY_HOME || path.join(process.cwd(), "artifacts", "relay-home"));
const workspaceRoot = path.resolve(process.env.DEV_LOG_RELAY_WORKSPACE_ROOT || process.cwd());
const servicePort = String(process.env.DEV_LOG_RELAY_MINIAPP_SERVICE_PORT || "9420");
const cliPath = process.env.DEV_LOG_RELAY_MINIAPP_CLI_PATH || "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const token = String(process.env.DEV_LOG_RELAY_MINIAPP_SIDECAR_TOKEN || "").trim();
const profileDir = path.join(relayHome, "wechat-devtools-profile");
const stateFile = path.join(relayHome, "state", "wechat-bootstrap.json");
let devtoolsProcess = null;

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function authorized(request) {
  if (!token) return false;
  return request.headers.authorization === `Bearer ${token}`;
}

async function canConnect(portValue) {
  const numeric = Number(portValue);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: numeric });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function automatorAvailable() {
  try {
    await import("miniprogram-automator");
    return true;
  } catch {
    return false;
  }
}

async function bootstrapState() {
  let marker = null;
  try {
    marker = JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch {
    marker = null;
  }
  return {
    relayHome,
    workspaceRoot,
    profileDir,
    stateFile,
    servicePort,
    cliPath,
    markerExists: Boolean(marker),
    marker,
    cliExists: await exists(cliPath),
  };
}

async function openDevTools() {
  const state = await bootstrapState();
  if (!state.cliExists) {
    return { ok: false, reasonCode: "miniapp_cli_not_found", state };
  }
  if (devtoolsProcess && devtoolsProcess.exitCode === null) {
    return { ok: true, alreadyRunning: true, pid: devtoolsProcess.pid, state };
  }
  const args = ["open", "--project", workspaceRoot];
  devtoolsProcess = spawn(cliPath, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: profileDir,
      USERPROFILE: profileDir,
      DEV_LOG_RELAY_HOME: relayHome,
      DEV_LOG_RELAY_MINIAPP_SERVICE_PORT: servicePort,
    },
  });
  devtoolsProcess.unref();
  return { ok: true, pid: devtoolsProcess.pid, args, state };
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, {
        ok: true,
        pid: process.pid,
        sidecar: "miniapp",
        tokenRequired: true,
      });
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      if (!authorized(request)) {
        json(response, 401, { ok: false, reasonCode: "miniapp_sidecar_token_required" });
        return;
      }
      const state = await bootstrapState();
      const servicePortReachable = await canConnect(servicePort);
      json(response, 200, {
        ok: true,
        pid: process.pid,
        sidecar: "miniapp",
        state,
        servicePortReachable,
        automatorAvailable: await automatorAvailable(),
        controlledDevToolsProcess: devtoolsProcess && devtoolsProcess.exitCode === null ? { pid: devtoolsProcess.pid } : null,
      });
      return;
    }
    if (request.method === "POST" && request.url === "/devtools/open") {
      if (!authorized(request)) {
        json(response, 401, { ok: false, reasonCode: "miniapp_sidecar_token_required" });
        return;
      }
      json(response, 200, await openDevTools());
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      if (!authorized(request)) {
        json(response, 401, { ok: false, reasonCode: "miniapp_sidecar_token_required" });
        return;
      }
      json(response, 200, { ok: true, shuttingDown: true });
      setTimeout(() => process.exit(0), 50);
      return;
    }
    json(response, 404, { ok: false, reasonCode: "not_found" });
  } catch (error) {
    json(response, 500, { ok: false, reasonCode: "miniapp_sidecar_error", message: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1");
