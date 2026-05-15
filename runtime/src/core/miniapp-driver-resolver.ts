import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { MiniappDevToolsBootstrapResult, MiniappDriverResolution, MiniappDriverType } from "../types.js";

const require = createRequire(import.meta.url);

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function resolveMaybe(root: string, value?: string): string {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
}

function readAutomatorVersion(): string {
  const customModule = String(process.env.DEV_LOG_RELAY_MINIAPP_AUTOMATOR_MODULE || "").trim();
  if (customModule) return "custom-module";
  try {
    const mod = require.resolve("miniprogram-automator/package.json", { paths: [process.cwd()] });
    const pkg = JSON.parse(fs.readFileSync(mod, "utf8")) as { version?: string };
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

export function resolveMiniappDriver(input: {
  workspaceRoot: string;
  driver: MiniappDriverType | string;
  driverModule?: string;
  ledger?: string;
  cliPath?: string;
  servicePort?: string;
  projectPath?: string;
  bootstrap?: MiniappDevToolsBootstrapResult;
}): MiniappDriverResolution {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const projectConfig = path.join(workspaceRoot, "project.config.json");
  const appJson = path.join(workspaceRoot, "app.json");
  const projectPath = resolveMaybe(workspaceRoot, input.projectPath) || (exists(projectConfig) || exists(appJson) ? workspaceRoot : "");
  const driverModule = resolveMaybe(workspaceRoot, input.driverModule || process.env.DEV_LOG_RELAY_MINIAPP_DRIVER_MODULE);
  const ledgerRef = resolveMaybe(workspaceRoot, input.ledger || process.env.DEV_LOG_RELAY_COMPUTER_USE_LEDGER);
  const cliPath = resolveMaybe(workspaceRoot, input.cliPath || process.env.DEV_LOG_RELAY_MINIAPP_CLI_PATH || "/Applications/wechatwebdevtools.app/Contents/MacOS/cli");
  const servicePort = String(input.servicePort || process.env.DEV_LOG_RELAY_MINIAPP_SERVICE_PORT || "");
  const automatorVersion = readAutomatorVersion();
  const servicePortReachable = Boolean(input.bootstrap?.servicePortReachable || input.bootstrap?.sidecar?.servicePortReachable);
  const profileIsolation = input.bootstrap?.profileIsolation || input.bootstrap?.sidecar?.profileIsolation || "unverified";
  const reasonCodes: string[] = [];
  const blockingReasons: string[] = [];
  const capabilities: string[] = [];
  const driver = String(input.driver || "devtools-automator");

  if (!projectPath) {
    reasonCodes.push("miniapp_project_path_unresolved");
    blockingReasons.push("Miniapp project path could not be resolved from project.config.json or app.json.");
  } else {
    capabilities.push("projectPath");
  }

  let mode: MiniappDriverResolution["mode"] = "none";
  if (driver === "computer-use") {
    mode = "computer-use-ledger";
    if (!ledgerRef || !exists(ledgerRef)) {
      reasonCodes.push("computer_use_ledger_required");
      blockingReasons.push("Computer Use driver requires a real ledger file.");
    } else {
      capabilities.push("computerUseLedger");
    }
  } else if (driverModule) {
    mode = "driverModule";
    if (!exists(driverModule)) {
      reasonCodes.push("driver_required");
      blockingReasons.push("Configured driverModule does not exist.");
    } else {
      capabilities.push("driverModule");
    }
  } else if (driver === "devtools-automator") {
    mode = "builtin-devtools-automator";
    if (!automatorVersion) {
      reasonCodes.push("builtin_miniapp_driver_unavailable");
      blockingReasons.push("miniprogram-automator is not installed or cannot be resolved.");
    } else {
      capabilities.push("miniprogramAutomator", "builtinDevtoolsAutomator");
    }
    if (!servicePort) {
      reasonCodes.push("miniapp_service_port_required");
      blockingReasons.push("WeChat DevTools service port is required for built-in DevTools automator.");
    } else {
      capabilities.push("servicePort");
    }
    if (servicePortReachable) {
      capabilities.push("servicePortReachable");
    }
    if (!cliPath || !exists(cliPath)) {
      if (!servicePortReachable) {
        reasonCodes.push("miniapp_cli_not_found");
        blockingReasons.push("WeChat DevTools CLI was not found, and no reachable service port is available to connect.");
      }
    } else {
      capabilities.push("wechatDevToolsCli");
    }
    if (profileIsolation !== "unverified") {
      capabilities.push("profileIsolation");
    }
  } else {
    mode = "devtools-connect";
    reasonCodes.push("driver_required");
    blockingReasons.push("Miniapp harness requires driverModule unless using Computer Use ledger.");
  }

  if (driver === "devtools-automator" && mode === "devtools-connect") {
    if (!cliPath || !exists(cliPath)) {
      reasonCodes.push("miniapp_cli_not_found");
      blockingReasons.push("WeChat DevTools CLI was not found for DevTools connect mode.");
    } else {
      capabilities.push("wechatDevToolsCli");
    }
    if (!servicePort) {
      reasonCodes.push("miniapp_service_port_required");
      blockingReasons.push("WeChat DevTools service port is required for DevTools connect mode.");
    } else {
      capabilities.push("servicePort");
    }
    if (!automatorVersion) {
      reasonCodes.push("miniapp_automator_version_unsupported");
      blockingReasons.push("miniprogram-automator is not installed or cannot be resolved.");
    } else {
      capabilities.push("miniprogramAutomator");
    }
    reasonCodes.push("miniapp_connect_mode_required");
    blockingReasons.push("DevTools connect mode is not enough by itself; provide a driverModule or Computer Use ledger for closure evidence.");
  }

  const uniqueReasonCodes = Array.from(new Set(reasonCodes));
  const required = uniqueReasonCodes.length > 0;
  return {
    required,
    status: required ? "missing" : "available",
    mode,
    projectPath,
    driverModule: driverModule || undefined,
    ledgerRef: ledgerRef || undefined,
    cliPath,
    servicePort,
    automatorVersion,
    capabilities: Array.from(new Set(capabilities)),
    reasonCodes: uniqueReasonCodes,
    blockingReasons,
    profileIsolation,
    recommendedAction:
      uniqueReasonCodes.length === 0
        ? "Miniapp driver resolution is ready."
        : driver === "devtools-automator"
          ? "Run relay harness verify --target miniapp to auto-prepare DevTools, or relay miniapp doctor --fix --pretty for detailed diagnostics."
          : "Pass --driverModule, provide a valid Computer Use ledger, or configure WeChat DevTools CLI/service port for this target project.",
  };
}
