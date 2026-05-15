import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MiniappBootstrapPairingPlan, MiniappDevToolsBootstrapResult, MiniappSidecarStatus } from "../types.js";

const SECURITY_STORAGE_FILE = "localstorage_b72da75d79277d2f5f9c30c9177be57e.json";
const SIDECAR_LABEL = "com.dev-log-relay.miniapp-sidecar";

function resolveMaybe(root: string, value?: string): string {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
}

function relayHome(): string {
  if (process.env.DEV_LOG_RELAY_HOME && process.env.DEV_LOG_RELAY_HOME !== "undefined") {
    return path.resolve(process.env.DEV_LOG_RELAY_HOME);
  }
  const storeRoot = process.env.DEV_LOG_RELAY_RUNTIME_STORE_DIR || path.join(process.cwd(), "artifacts", "relay-store");
  const absoluteStoreRoot = path.isAbsolute(storeRoot) ? storeRoot : path.resolve(process.cwd(), storeRoot);
  return path.join(path.dirname(absoluteStoreRoot), "relay-home");
}

function defaultCliPath(): string {
  return "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
}

function defaultSidecarPort(): string {
  return String(process.env.DEV_LOG_RELAY_MINIAPP_SIDECAR_PORT || "5078");
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function exists(filePath: string): boolean {
  try {
    return fsSync.existsSync(filePath);
  } catch {
    return false;
  }
}

async function canConnect(port: string): Promise<boolean> {
  const numeric = Number(port);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: numeric });
    const done = (value: boolean) => {
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

async function httpHealth(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function requestJson(url: string, token?: string): Promise<Record<string, unknown> | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function securityConfig(port: string): Record<string, unknown> {
  return {
    "security.enableServicePort": true,
    "security.port": Number(port),
    "security.allowGetTicket": true,
    "security.trustWhenAuto": true,
  };
}

function pairingPlan(input: {
  servicePort: string;
  projectPath: string;
  profileDir: string;
}): MiniappBootstrapPairingPlan {
  return {
    driver: "computer-use",
    reasonCode: "bootstrap_pairing_required",
    targetApp: "微信开发者工具",
    servicePort: input.servicePort,
    projectPath: input.projectPath,
    profileDir: input.profileDir,
    expectedSettings: securityConfig(input.servicePort),
    steps: [
      "Open WeChat DevTools.",
      "Open Settings -> Security Settings.",
      `Enable Service Port and set the port to ${input.servicePort} when the UI exposes a port field.`,
      "Enable automation/trust/ticket related toggles when present.",
      "Close settings and leave WeChat DevTools running.",
      "Run relay miniapp doctor --fix --pretty to verify the service port and driver readiness.",
    ],
    verification: {
      command: "relay miniapp doctor --fix --pretty",
      expectedSignals: ["bootstrap.ok=true", `bootstrap.servicePort=${input.servicePort}`, "driverResolution.status=available when a driverModule or ledger is present"],
    },
    ledgerTemplate: {
      kind: "miniapp-bootstrap-pairing-ledger",
      driver: "computer-use",
      targetApp: "微信开发者工具",
      createdAt: new Date().toISOString(),
      projectPath: input.projectPath,
      servicePort: input.servicePort,
      profileDir: input.profileDir,
      actions: [],
      visibleEvidence: [],
      verificationCommand: "relay miniapp doctor --fix --pretty",
    },
  };
}

export function resolveMiniappSidecarPaths(input: { workspaceRoot: string; sidecarPort?: string }) {
  const home = relayHome();
  const sidecarScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../sidecar/miniapp-sidecar.mjs");
  const launchAgentDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const launchAgentPath = path.join(launchAgentDir, `${SIDECAR_LABEL}.plist`);
  const tokenFile = path.join(home, "state", "miniapp-sidecar-token");
  const port = String(input.sidecarPort || defaultSidecarPort());
  return {
    home,
    launchAgentDir,
    launchAgentPath,
    sidecarScript,
    tokenFile,
    port,
    healthUrl: `http://127.0.0.1:${port}/health`,
    statusUrl: `http://127.0.0.1:${port}/status`,
  };
}

function launchAgentPlist(input: {
  workspaceRoot: string;
  sidecarScript: string;
  port: string;
  home: string;
  logDir: string;
  token: string;
  servicePort: string;
  cliPath: string;
}): string {
  const nodePath = process.execPath;
  const env = {
    DEV_LOG_RELAY_HOME: input.home,
    DEV_LOG_RELAY_WORKSPACE_ROOT: input.workspaceRoot,
    DEV_LOG_RELAY_MINIAPP_SIDECAR_PORT: input.port,
    DEV_LOG_RELAY_MINIAPP_SIDECAR_TOKEN: input.token,
    DEV_LOG_RELAY_MINIAPP_SERVICE_PORT: input.servicePort,
    DEV_LOG_RELAY_MINIAPP_CLI_PATH: input.cliPath,
  };
  const envXml = Object.entries(env)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(SIDECAR_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(input.sidecarScript)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(input.logDir, "miniapp-sidecar.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(input.logDir, "miniapp-sidecar.err.log"))}</string>
</dict>
</plist>
`;
}

async function readToken(filePath: string): Promise<string> {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}

async function ensureToken(filePath: string): Promise<string> {
  const existing = await readToken(filePath);
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${token}\n`, { mode: 0o600 });
  return token;
}

async function runLaunchctl(args: string[]): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== "darwin") {
    return { ok: false, message: "launchctl_unavailable_non_macos" };
  }
  return new Promise((resolve) => {
    const child = spawn("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, message: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, message: `${out}${err}`.trim() || `exit_${code}` }));
  });
}

async function checkMiniappSidecar(input: { workspaceRoot: string; sidecarPort?: string }): Promise<MiniappSidecarStatus> {
  const paths = resolveMiniappSidecarPaths(input);
  const installed = exists(paths.launchAgentPath);
  const token = await readToken(paths.tokenFile);
  const health = await requestJson(paths.healthUrl);
  const protectedStatus = token ? await requestJson(paths.statusUrl, token) : null;
  const running = Boolean(health?.ok);
  const protectedStatusOk = Boolean(protectedStatus?.ok);
  const state = (protectedStatus?.state || health?.state || {}) as Record<string, unknown>;
  const servicePortReachable = protectedStatus ? Boolean(protectedStatus.servicePortReachable) : false;
  const cliExists = Boolean(state.cliExists);
  const markerExists = Boolean(state.markerExists);
  const controlledDevToolsProcess = protectedStatus?.controlledDevToolsProcess && typeof protectedStatus.controlledDevToolsProcess === "object"
    ? protectedStatus.controlledDevToolsProcess as Record<string, unknown>
    : null;
  const profileIsolation: MiniappSidecarStatus["profileIsolation"] = controlledDevToolsProcess
    ? "verified"
    : protectedStatusOk || running
      ? "attempted"
      : "unverified";
  const reasonCodes = [
    ...(!installed ? ["miniapp_sidecar_not_installed"] : []),
    ...(!running ? ["miniapp_sidecar_not_running"] : []),
    ...(running && !protectedStatusOk ? ["miniapp_sidecar_token_required"] : []),
    ...(protectedStatusOk && !markerExists ? ["miniapp_bootstrap_required"] : []),
    ...(protectedStatusOk && !cliExists ? ["miniapp_cli_not_found"] : []),
    ...(protectedStatusOk && !servicePortReachable ? ["miniapp_service_port_unreachable"] : []),
  ];
  return {
    ok: reasonCodes.length === 0,
    installed,
    running,
    launchAgentPath: paths.launchAgentPath,
    sidecarScript: paths.sidecarScript,
    port: paths.port,
    healthUrl: paths.healthUrl,
    statusUrl: paths.statusUrl,
    tokenFile: paths.tokenFile,
    servicePort: String(state.servicePort || ""),
    servicePortReachable,
    cliExists,
    markerExists,
    protectedStatusOk,
    controlledDevToolsProcess,
    profileIsolation,
    reasonCodes,
    recommendedAction: reasonCodes.length === 0 ? "Miniapp sidecar is installed and healthy." : "Run relay miniapp sidecar install --start --pretty from the host Codex environment.",
  };
}

export async function manageMiniappSidecar(input: {
  workspaceRoot: string;
  action: "check" | "install" | "start" | "stop";
  sidecarPort?: string;
  servicePort?: string;
  cliPath?: string;
  dryRun?: boolean;
}): Promise<MiniappSidecarStatus & { plistPath?: string; plistPreview?: string }> {
  const paths = resolveMiniappSidecarPaths(input);
  const logDir = path.join(paths.home, "logs");
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const token = input.dryRun ? "dry-run-token" : await ensureToken(paths.tokenFile);
  const plist = launchAgentPlist({
    workspaceRoot,
    sidecarScript: paths.sidecarScript,
    port: paths.port,
    home: paths.home,
    logDir,
    token,
    servicePort: String(input.servicePort || process.env.DEV_LOG_RELAY_MINIAPP_SERVICE_PORT || "9420"),
    cliPath: resolveMaybe(workspaceRoot, input.cliPath || process.env.DEV_LOG_RELAY_MINIAPP_CLI_PATH || defaultCliPath()),
  });
  const launchctlMessages: string[] = [];

  if (input.action === "install") {
    if (!input.dryRun) {
      await fs.mkdir(paths.launchAgentDir, { recursive: true });
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(paths.launchAgentPath, plist, "utf8");
      const bootout = await runLaunchctl(["bootout", `gui/${process.getuid?.() || os.userInfo().uid}`, paths.launchAgentPath]);
      launchctlMessages.push(`bootout:${bootout.ok}:${bootout.message}`);
      const bootstrap = await runLaunchctl(["bootstrap", `gui/${process.getuid?.() || os.userInfo().uid}`, paths.launchAgentPath]);
      launchctlMessages.push(`bootstrap:${bootstrap.ok}:${bootstrap.message}`);
    }
  }

  if (input.action === "start" || (input.action === "install" && !input.dryRun)) {
    const running = await httpHealth(paths.healthUrl);
    if (!running) {
      if (exists(paths.launchAgentPath) && process.platform === "darwin") {
        const kickstart = await runLaunchctl(["kickstart", "-k", `gui/${process.getuid?.() || os.userInfo().uid}/${SIDECAR_LABEL}`]);
        launchctlMessages.push(`kickstart:${kickstart.ok}:${kickstart.message}`);
      }
      const child = spawn(process.execPath, [paths.sidecarScript], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          DEV_LOG_RELAY_HOME: paths.home,
          DEV_LOG_RELAY_WORKSPACE_ROOT: workspaceRoot,
          DEV_LOG_RELAY_MINIAPP_SIDECAR_PORT: paths.port,
          DEV_LOG_RELAY_MINIAPP_SIDECAR_TOKEN: token,
          DEV_LOG_RELAY_MINIAPP_SERVICE_PORT: String(input.servicePort || process.env.DEV_LOG_RELAY_MINIAPP_SERVICE_PORT || "9420"),
          DEV_LOG_RELAY_MINIAPP_CLI_PATH: resolveMaybe(workspaceRoot, input.cliPath || process.env.DEV_LOG_RELAY_MINIAPP_CLI_PATH || defaultCliPath()),
        },
      });
      child.unref();
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    try {
      await fetch(`http://127.0.0.1:${paths.port}/devtools/open`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    } catch {
      launchctlMessages.push("devtools_open:false:request_failed");
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const status = await requestJson(paths.statusUrl, token);
      if (status?.servicePortReachable === true) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (input.action === "stop") {
    try {
      await fetch(`http://127.0.0.1:${paths.port}/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Best-effort stop; LaunchAgent may restart it if installed with KeepAlive.
    }
  }

  const status = await checkMiniappSidecar(input);
  return {
    ...status,
    launchctlMessages,
    plistPath: paths.launchAgentPath,
    plistPreview: input.dryRun ? plist : undefined,
  };
}

async function mergeJson(filePath: string, patch: Record<string, unknown>) {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    current = {};
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
}

function managedConfigFiles(profileDir: string): string[] {
  return [
    path.join(profileDir, "WeappLocalData", SECURITY_STORAGE_FILE),
    path.join(profileDir, "Library", "Application Support", "微信开发者工具", "dev-log-relay", "WeappLocalData", SECURITY_STORAGE_FILE),
  ];
}

export async function bootstrapMiniappDevTools(input: {
  workspaceRoot: string;
  fix?: boolean;
  driver?: string;
  cliPath?: string;
  servicePort?: string;
  projectPath?: string;
  profileDir?: string;
  sidecarPort?: string;
}): Promise<MiniappDevToolsBootstrapResult> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const home = relayHome();
  const profileDir = path.resolve(input.profileDir || process.env.DEV_LOG_RELAY_WECHAT_DEVTOOLS_PROFILE_DIR || path.join(home, "wechat-devtools-profile"));
  const managedHome = profileDir;
  const stateDir = path.join(home, "state");
  const stateFile = path.join(stateDir, "wechat-bootstrap.json");
  const cliPath = resolveMaybe(workspaceRoot, input.cliPath || process.env.DEV_LOG_RELAY_MINIAPP_CLI_PATH || defaultCliPath());
  const servicePort = String(input.servicePort || process.env.DEV_LOG_RELAY_MINIAPP_SERVICE_PORT || "9420");
  const projectPath = resolveMaybe(workspaceRoot, input.projectPath) || workspaceRoot;
  const configFiles = managedConfigFiles(profileDir);
  const reasonCodes: string[] = [];
  const blockingReasons: string[] = [];
  const markerExists = exists(stateFile);

  if (!servicePort) {
    reasonCodes.push("miniapp_service_port_required");
    blockingReasons.push("Miniapp DevTools service port is required.");
  }

  if (!input.fix && !markerExists) {
    reasonCodes.push("miniapp_bootstrap_required");
    blockingReasons.push("Dev Log Relay managed WeChat DevTools profile has not been bootstrapped.");
  }

  if (input.fix) {
    try {
      await fs.mkdir(profileDir, { recursive: true });
      await fs.mkdir(stateDir, { recursive: true });
      for (const filePath of configFiles) {
        await mergeJson(filePath, securityConfig(servicePort));
      }
      await fs.writeFile(
        stateFile,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            profileDir,
            managedHome,
            cliPath,
            projectPath,
            servicePort,
            configFiles,
            security: securityConfig(servicePort),
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    } catch (error) {
      reasonCodes.push("miniapp_profile_write_failed");
      blockingReasons.push(`Could not write managed WeChat DevTools profile: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const [servicePortReachable, sidecar] = await Promise.all([
    canConnect(servicePort),
    checkMiniappSidecar({ workspaceRoot, sidecarPort: input.sidecarPort }).catch(() => undefined),
  ]);
  const uniqueReasonCodes = Array.from(new Set(reasonCodes));
  const ok = uniqueReasonCodes.length === 0;
  const pairingRequired = !ok && input.driver === "computer-use";
  const profileIsolation = sidecar?.profileIsolation || (servicePortReachable ? "attempted" : "unverified");
  return {
    ok,
    status: ok ? "ready" : pairingRequired ? "pairing_required" : input.fix ? "failed" : "needs_fix",
    profileDir,
    managedHome,
    stateFile,
    cliPath,
    projectPath,
    servicePort,
    servicePortReachable,
    markerExists: markerExists || Boolean(input.fix),
    configFiles,
    reasonCodes: uniqueReasonCodes,
    blockingReasons,
    recommendedAction: ok
      ? "Managed Miniapp DevTools profile is bootstrapped. Use relay miniapp driver check, then relay harness verify --target miniapp."
      : pairingRequired
        ? "Use the returned Computer Use pairingPlan, then rerun relay miniapp doctor --fix --pretty."
      : "Run relay miniapp bootstrap --fix from the host environment. If macOS blocks profile writes or DevTools control, complete the first-time DevTools permission prompt once, then rerun.",
    pairingPlan: input.driver === "computer-use" ? pairingPlan({ servicePort, projectPath, profileDir }) : undefined,
    sidecar,
    autoPrepareAttempted: Boolean(input.fix),
    sidecarStarted: Boolean(sidecar?.running),
    profileIsolation,
  };
}
