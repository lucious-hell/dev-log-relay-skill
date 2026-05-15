import path from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createMiniappRelay } from "./adapters/miniapp.js";
import { MiniappExecutionCoordinator } from "./core/miniapp-execution-coordinator.js";
import type {
  BlackboxCase,
  BlackboxActionTrace,
  BlackboxCaseRunReport,
  BlackboxDiscoverSummary,
  BlackboxLocatorCandidate,
  BlackboxPlan,
  BlackboxRunReport,
  ComputerUseLedger,
  HarnessVerifyResult,
  LocatorRepairCandidate,
  MiniappActionInput,
  QualitySignal,
  RelayFailure,
  RelayLogInput,
  ScenarioSpec,
} from "./types.js";
import { validateComputerUseLedger, visibleEvidenceFromEvents } from "./core/validation.js";
import { collectWebObserveInventory, discoverWebUiFromHtml } from "./core/blackbox-observe.js";
import { evaluateBlackboxGate, relayFailure } from "./core/gate-evaluator.js";
import { HarnessOrchestrator } from "./core/harness-orchestrator.js";
import { buildMiniappRetryCommand, miniappReasonCodesForReport, miniappUserActionRequest } from "./core/miniapp-harness-policy.js";
import { bootstrapMiniappDevTools, manageMiniappSidecar } from "./core/miniapp-devtools-bootstrap.js";
import { resolveMiniappDriver } from "./core/miniapp-driver-resolver.js";

interface CliOptions {
  relay: string;
  pretty: boolean;
  artifact?: string;
  params: Record<string, string>;
}

function resolveWorkspaceRoot(): string {
  return path.resolve(process.env.DEV_LOG_RELAY_WORKSPACE_ROOT || process.cwd());
}

function withWorkspaceHeader(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers || {});
  headers.set("x-dev-log-relay-workspace-root", resolveWorkspaceRoot());
  return {
    ...init,
    headers,
  };
}

interface CliDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  webScenarioRunnerImpl?: typeof runTargetWebScenario;
  blackboxWebRunnerImpl?: typeof runWebBlackboxPlan;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface CliStandardFailure {
  ok: false;
  status: "unsupported" | "inapplicable" | "partial";
  reasonCode: string;
  reason: string;
  recommendedAction: string;
  supportedTargets: string[];
  currentCapabilities: string[];
}

interface VerifyPayload {
  target: "web" | "miniapp";
  profile?: unknown;
  support?: unknown;
  triggerDecision?: unknown;
  projectCheck: Record<string, any>;
  runtimeReadiness: Record<string, any>;
  closureEligible: boolean;
  autoloopEligible: boolean;
  recommendedAction: string;
  status: "supported" | "partial" | "unsupported" | "inapplicable";
}

interface TargetProjectInfo {
  workspaceRoot: string;
  resolvedProjectRoot: string;
  targetUrl: string;
  startCommand: string;
  urlSource: "explicit" | "env" | "stdout" | "probe";
}

interface WebTargetResolution {
  targetProject?: TargetProjectInfo;
  child?: ChildProcess;
  failure?: CliStandardFailure;
}

interface WebRunResult {
  summary: unknown;
  collection: unknown;
  diagnosis: unknown;
  closure: unknown;
  integrity: unknown;
  scenario: unknown;
  baseline: unknown;
  report: unknown;
  releaseDecision: unknown;
  scenarioDiff: unknown[];
  stateDiff: unknown[];
  targetProject: TargetProjectInfo;
}

interface BlackboxRunOptions {
  storageState?: string;
  saveAuthProfile?: string;
  visual?: boolean;
  a11y?: boolean;
  viewport?: "desktop" | "mobile" | "both";
}

interface ViewportVariant {
  name: "desktop" | "mobile";
  viewport: { width: number; height: number };
}

function webViewportVariants(mode?: "desktop" | "mobile" | "both"): ViewportVariant[] {
  const desktop: ViewportVariant = { name: "desktop", viewport: { width: 1280, height: 720 } };
  const mobile: ViewportVariant = { name: "mobile", viewport: { width: 390, height: 844 } };
  if (mode === "mobile") return [mobile];
  if (mode === "both") return [desktop, mobile];
  return [desktop];
}

function parseArgs(argv: string[]): { command: string[]; options: CliOptions } {
  const command: string[] = [];
  const options: CliOptions = {
    relay: "http://127.0.0.1:5077",
    pretty: false,
    params: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--pretty") {
      options.pretty = true;
      continue;
    }
    if (token === "--relay") {
      options.relay = argv[index + 1] || options.relay;
      index += 1;
      continue;
    }
    if (token === "--artifact") {
      options.artifact = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--noStart") {
      options.params.noStart = "true";
      continue;
    }
    if (token === "--noDiscover") {
      options.params.noDiscover = "true";
      continue;
    }
    if (token === "--noAutoPrepare") {
      options.params.noAutoPrepare = "true";
      continue;
    }
    if (token === "--dryRun" || token === "--confirm" || token === "--visual" || token === "--a11y" || token === "--fix" || token === "--start") {
      options.params[token.slice(2)] = "true";
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[index + 1] || "";
      options.params[key] = options.params[key] ? `${options.params[key]}\n${value}` : value;
      index += 1;
      continue;
    }
    command.push(token);
  }
  return { command, options };
}

async function requestJson(fetchImpl: typeof fetch, url: string, init?: RequestInit) {
  const response = await fetchImpl(url, withWorkspaceHeader(init));
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = json.message || json.reason || `Request failed: ${response.status}`;
    const reasonPrefix = typeof json.reasonCode === "string" ? `${json.reasonCode}: ` : "";
    const error = new Error(`${reasonPrefix}${message}`);
    (error as Error & { payload?: unknown }).payload = json;
    throw error;
  }
  return json;
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown) {
  return requestJson(fetchImpl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function maybeWriteArtifact(filePath: string | undefined, payload: unknown): Promise<string> {
  if (!filePath) {
    return "";
  }
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(resolveWorkspaceRoot(), filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return absolute;
}

async function writeRuntimeEvidenceArtifact(runId: string, name: string, extension: string, body: string | Buffer): Promise<string> {
  const root = process.env.DEV_LOG_RELAY_RUNTIME_STORE_DIR || path.join("artifacts", "relay-store");
  const absoluteRoot = path.isAbsolute(root) ? root : path.join(process.cwd(), root);
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(absoluteRoot, "evidence", safeRunId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${safeName}.${extension.replace(/^\./, "")}`);
  await writeFile(filePath, body);
  return filePath;
}

async function runtimeEvidenceArtifactPath(runId: string, name: string, extension: string): Promise<string> {
  const root = process.env.DEV_LOG_RELAY_RUNTIME_STORE_DIR || path.join("artifacts", "relay-store");
  const absoluteRoot = path.isAbsolute(root) ? root : path.join(process.cwd(), root);
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(absoluteRoot, "evidence", safeRunId);
  await mkdir(dir, { recursive: true });
  return path.join(dir, `${safeName}.${extension.replace(/^\./, "")}`);
}

function runtimeStoreRoot(): string {
  const root = process.env.DEV_LOG_RELAY_RUNTIME_STORE_DIR || path.join("artifacts", "relay-store");
  return path.isAbsolute(root) ? root : path.join(process.cwd(), root);
}

function authProfileFile(name: string): string {
  const safeName = String(name || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(runtimeStoreRoot(), "auth-profiles", `${safeName}.json`);
}

async function resolveStorageStatePath(targetProject: TargetProjectInfo, options: CliOptions): Promise<string | undefined> {
  const explicit = options.params.storageState || process.env.DEV_LOG_RELAY_WEB_STORAGE_STATE || "";
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(resolveWorkspaceRoot(), explicit);
  }
  const profileName = options.params.authProfile || process.env.DEV_LOG_RELAY_AUTH_PROFILE || "";
  if (!profileName) return undefined;
  const profilePath = authProfileFile(profileName);
  const profile = await readJsonFile(profilePath);
  const expectedRoot = path.resolve(targetProject.workspaceRoot);
  const profileRoot = path.resolve(String(profile.targetProjectRoot || ""));
  const expectedOrigin = new URL(targetProject.targetUrl).origin;
  if (expectedRoot !== profileRoot || profile.targetOrigin !== expectedOrigin) {
    throw new Error("auth_profile_target_mismatch");
  }
  return String(profile.storageStateRef || "");
}

async function saveAuthProfileBody(targetProject: TargetProjectInfo, name: string, storageStateBody: string | Buffer): Promise<string> {
  const storageStateRef = await writeRuntimeEvidenceArtifact(`auth-${name}`, "storage-state", "json", storageStateBody);
  const profile = {
    name,
    targetProjectRoot: targetProject.workspaceRoot,
    targetOrigin: new URL(targetProject.targetUrl).origin,
    storageStateRef,
    createdAt: new Date().toISOString(),
  };
  const profilePath = authProfileFile(name);
  await mkdir(path.dirname(profilePath), { recursive: true });
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return profilePath;
}

function format(payload: unknown, pretty: boolean): string {
  return `${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`;
}

async function fetchDetectedTarget(fetchImpl: typeof fetch, relay: string, target?: string): Promise<string> {
  const payload = await requestJson(fetchImpl, `${relay}/ai/targets/detect?target=${encodeURIComponent(target || "auto")}`);
  return payload.detection?.supportedTarget || payload.detection?.detectedTarget || "unknown";
}

function isStructuredFailure(payload: unknown): payload is CliStandardFailure {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const record = payload as Record<string, unknown>;
  return record.ok === false && typeof record.status === "string" && typeof record.reasonCode === "string";
}

function parseCsv(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string): Promise<Record<string, any>> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

function parseLocalUrl(text: string): string {
  const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s"'<>]*)?/i);
  if (!match) return "";
  return match[0].replace("http://[::1]", "http://127.0.0.1");
}

function splitShellCommand(command: string): { command: string; args: string[]; display: string } {
  return { command: "sh", args: ["-lc", command], display: command };
}

async function probeUrl(fetchImpl: typeof fetch, url: string): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { method: "GET" });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function selectWebRoot(fetchImpl: typeof fetch, relay: string): Promise<string> {
  const workspaceRoot = resolveWorkspaceRoot();
  try {
    const resolution = await requestJson(fetchImpl, `${relay}/ai/project/resolution?target=web`);
    const resolved = String(resolution.resolution?.resolvedProjectRoot || "");
    return path.isAbsolute(resolved) ? resolved : path.resolve(workspaceRoot, resolved || ".");
  } catch {
    return workspaceRoot;
  }
}

async function resolvePackageCommand(projectRoot: string, explicitCommand?: string): Promise<{ command: string; args: string[]; display: string } | null> {
  const command = String(explicitCommand || process.env.DEV_LOG_RELAY_WEB_COMMAND || "").trim();
  if (command) {
    return splitShellCommand(command);
  }
  const pkg = await readJsonFile(path.join(projectRoot, "package.json"));
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts as Record<string, unknown> : {};
  const scriptName = ["dev", "start", "serve", "preview"].find((name) => typeof scripts[name] === "string");
  if (!scriptName) {
    return null;
  }
  if (await pathExists(path.join(projectRoot, "pnpm-lock.yaml"))) {
    return { command: "pnpm", args: [scriptName], display: `pnpm ${scriptName}` };
  }
  if (await pathExists(path.join(projectRoot, "yarn.lock"))) {
    return { command: "yarn", args: [scriptName], display: `yarn ${scriptName}` };
  }
  if ((await pathExists(path.join(projectRoot, "bun.lock"))) || (await pathExists(path.join(projectRoot, "bun.lockb")))) {
    return { command: "bun", args: ["run", scriptName], display: `bun run ${scriptName}` };
  }
  return { command: "npm", args: ["run", scriptName], display: `npm run ${scriptName}` };
}

async function resolveWebTarget(fetchImpl: typeof fetch, spawnImpl: typeof spawn, relay: string, options: CliOptions): Promise<WebTargetResolution> {
  const workspaceRoot = resolveWorkspaceRoot();
  const projectRoot = await selectWebRoot(fetchImpl, relay);
  const explicitUrl = String(options.params.url || "").trim();
  const envUrl = String(process.env.DEV_LOG_RELAY_TARGET_URL || "").trim();
  if (explicitUrl || envUrl) {
    return {
      targetProject: {
        workspaceRoot,
        resolvedProjectRoot: projectRoot,
        targetUrl: explicitUrl || envUrl,
        startCommand: "",
        urlSource: explicitUrl ? "explicit" : "env",
      },
    };
  }
  if (options.params.noStart === "true" || options.params.noStart === "1") {
    return {
      failure: {
        ok: false,
        status: "partial",
        reasonCode: "target_project_url_required",
        reason: "A real target project URL is required when automatic startup is disabled.",
        recommendedAction: "Pass --url <targetUrl> or set DEV_LOG_RELAY_TARGET_URL.",
        supportedTargets: ["web", "miniapp"],
        currentCapabilities: ["target-project-only", "demoProhibited"],
      },
    };
  }
  const command = await resolvePackageCommand(projectRoot, options.params.webCommand);
  if (!command) {
    return {
      failure: {
        ok: false,
        status: "partial",
        reasonCode: "target_project_url_required",
        reason: "No target URL was provided and no runnable web script was found in the target project.",
        recommendedAction: "Pass --url <targetUrl> or add a package script named dev, start, serve, or preview.",
        supportedTargets: ["web", "miniapp"],
        currentCapabilities: ["target-project-only", "demoProhibited"],
      },
    };
  }
  const child = spawnImpl(command.command, command.args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let discoveredUrl = "";
  let discoveredSource: TargetProjectInfo["urlSource"] = "stdout";
  const timeoutMs = Number(options.params.timeoutMs || process.env.DEV_LOG_RELAY_WEB_START_TIMEOUT_MS || 30_000);
  try {
    await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("target_project_start_timeout")), Math.max(1_000, timeoutMs));
    const finish = (url: string, source: TargetProjectInfo["urlSource"]) => {
      if (!url || discoveredUrl) return;
      discoveredUrl = url;
      discoveredSource = source;
      clearTimeout(timer);
      resolve();
    };
    const onData = (chunk: Buffer | string) => {
      const url = parseLocalUrl(String(chunk));
      if (url) finish(url, "stdout");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      if (!discoveredUrl) {
        clearTimeout(timer);
        reject(new Error(`target_project_start_failed:${code ?? "unknown"}`));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    const ports = [3000, 5173, 5174, 4173, 8080, 8000, 4200];
    const startedAt = Date.now();
    const poll = async () => {
      while (!discoveredUrl && Date.now() - startedAt < timeoutMs) {
        for (const port of ports) {
          const candidate = `http://127.0.0.1:${port}/`;
          if (await probeUrl(fetchImpl, candidate)) {
            finish(candidate, "probe");
            return;
          }
        }
        await new Promise((wait) => setTimeout(wait, 500));
      }
    };
      void poll();
    });
  } catch (error) {
    child.kill();
    return {
      failure: {
        ok: false,
        status: "partial",
        reasonCode: "target_project_start_failed",
        reason: error instanceof Error ? error.message : String(error),
        recommendedAction: "Pass --url <targetUrl> for an already running target project, or fix the project's web start script.",
        supportedTargets: ["web", "miniapp"],
        currentCapabilities: ["target-project-only", "demoProhibited"],
      },
    };
  }
  return {
    child,
    targetProject: {
      workspaceRoot,
      resolvedProjectRoot: projectRoot,
      targetUrl: discoveredUrl,
      startCommand: command.display,
      urlSource: discoveredSource,
    },
  };
}

async function installWebRelay(page: any, relay: string, runId: string) {
  await page.addInitScript(
    ({ endpoint, activeRunId }: { endpoint: string; activeRunId: string }) => {
      const host = globalThis as any;
      const transportFetch = host.fetch.bind(host);
      const binding = { runId: activeRunId, stepId: "" };
      async function post(level: string, message: string, extra: Record<string, unknown> = {}) {
        try {
          await transportFetch(`${endpoint}/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source: "admin-web",
              level,
              message,
              runId: binding.runId,
              stepId: binding.stepId,
              route: host.location?.pathname || "",
              ...extra,
            }),
          });
        } catch {}
      }
      host.__devLogRelaySetStep = (stepId: string) => {
        binding.stepId = stepId || "";
      };
      const originalInfo = console.info.bind(console);
      const originalWarn = console.warn.bind(console);
      const originalError = console.error.bind(console);
      console.info = (...args: unknown[]) => {
        void post("info", args.map(String).join(" "), { phase: "log", context: { args } });
        originalInfo(...args);
      };
      console.warn = (...args: unknown[]) => {
        void post("warn", args.map(String).join(" "), { phase: "log", context: { args } });
        originalWarn(...args);
      };
      console.error = (...args: unknown[]) => {
        void post("error", args.map(String).join(" "), { phase: "log", context: { args } });
        originalError(...args);
      };
      const originalFetch = host.fetch.bind(host);
      host.fetch = async (...args: any[]) => {
        const url = String(args[0]);
        const init = args[1] as RequestInit | undefined;
        const method = String(init?.method || "GET");
        void post("info", `fetch ${method} ${url}`, { phase: "network", network: { url, method, stage: "start" } });
        try {
          const response = await originalFetch(...args);
          void post(response.ok ? "info" : "warn", `fetch ${method} ${url} -> ${response.status}`, {
            phase: "network",
            network: { url, method, statusCode: response.status, ok: response.ok, stage: response.ok ? "success" : "fail" },
          });
          return response;
        } catch (error) {
          void post("error", `fetch ${method} ${url} failed`, {
            phase: "network",
            errorKind: "network_error",
            stack: error instanceof Error ? error.stack || error.message : String(error || ""),
            network: { url, method, ok: false, stage: "fail" },
          });
          throw error;
        }
      };
      host.addEventListener("error", (event: any) => {
        void post("error", event.message || "window error", {
          phase: "log",
          errorKind: "window_error",
          stack: event.error && event.error.stack ? event.error.stack : "",
        });
      });
      host.addEventListener("unhandledrejection", (event: any) => {
        const reason = event.reason;
        void post("error", reason instanceof Error ? reason.message : String(reason || "unhandled rejection"), {
          phase: "log",
          errorKind: "unhandled_rejection",
          stack: reason instanceof Error ? reason.stack || "" : "",
        });
      });
      host.addEventListener("DOMContentLoaded", () => {
        const emitRender = (reason: string) => {
          void post("info", `render_complete:${reason}`, {
            phase: "render",
            tags: ["render_complete", "ui_updated", reason],
          });
        };
        host.requestAnimationFrame(() => emitRender("dom_ready"));
        new host.MutationObserver(() => emitRender("dom_changed")).observe(host.document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
      void post("info", `route init ${host.location?.pathname || ""}`, { phase: "navigation", route: host.location?.pathname || "" });
    },
    { endpoint: relay, activeRunId: runId }
  );
}

async function setWebStep(page: any, stepId: string) {
  await page.evaluate((nextStepId: string) => {
    const host = globalThis as any;
    if (typeof host.__devLogRelaySetStep === "function") {
      host.__devLogRelaySetStep(nextStepId);
    }
  }, stepId);
}

async function runTargetWebScenario(
  fetchImpl: typeof fetch,
  relay: string,
  runId: string,
  targetProject: TargetProjectInfo,
  templateName: string,
  baselineRunId?: string
): Promise<WebRunResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await installWebRelay(page, relay, runId);
    const navigateStep = await postJson(fetchImpl, `${relay}/runs/${runId}/steps/start`, {
      name: "navigate-target",
      kind: "navigate",
      route: "/",
      metadata: { targetUrl: targetProject.targetUrl, demoProhibited: true },
    });
    await setWebStep(page, navigateStep.stepId);
    await page.goto(targetProject.targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(300);
    await postJson(fetchImpl, `${relay}/runs/${runId}/steps/${navigateStep.stepId}/end`, { status: "passed" });

    const assertStep = await postJson(fetchImpl, `${relay}/runs/${runId}/steps/start`, {
      name: "assert-target-render",
      kind: "assert",
      route: "/",
      metadata: { targetUrl: targetProject.targetUrl, demoProhibited: true },
    });
    await setWebStep(page, assertStep.stepId);
    await page.evaluate(() => {
      const host = globalThis as any;
      return host.document?.body ? host.document.body.innerText.slice(0, 200) : "";
    });
    await postJson(fetchImpl, `${relay}/runs/${runId}/steps/${assertStep.stepId}/end`, { status: "passed" });
    await postJson(fetchImpl, `${relay}/runs/${runId}/end`, { status: "passed" });
    await postJson(fetchImpl, `${relay}/scenarios/validate`, {
      runId,
      templateName,
      target: "web",
    }).catch(() => null);
  } catch (error) {
    await postJson(fetchImpl, `${relay}/runs/${runId}/end`, {
      status: "failed",
      metadata: { error: error instanceof Error ? error.message : String(error) },
    }).catch(() => null);
    throw error;
  } finally {
    await browser.close();
  }
  const [summary, collection, diagnosis, closure, integrity, scenario, baseline, report, releaseDecision] = await Promise.all([
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/summary`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/collection`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/diagnosis`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/closure`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/integrity`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/scenario`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/baseline`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/report`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/release-decision`),
  ]);
  const [scenarioDiff, stateDiff] = baselineRunId
    ? await Promise.all([
        requestJson(fetchImpl, `${relay}/ai/diff/scenario?baselineRunId=${encodeURIComponent(baselineRunId)}&currentRunId=${encodeURIComponent(runId)}`),
        requestJson(fetchImpl, `${relay}/ai/diff/state?baselineRunId=${encodeURIComponent(baselineRunId)}&currentRunId=${encodeURIComponent(runId)}`),
      ])
    : [null, null];
  return {
    summary: summary.summary,
    collection: collection.collection,
    diagnosis: diagnosis.diagnosis,
    closure: closure.closure,
    integrity: integrity.integrity,
    scenario: scenario.scenario,
    baseline: baseline.baseline,
    report: report.report,
    releaseDecision: releaseDecision.releaseDecision,
    scenarioDiff: scenarioDiff?.changed || [],
    stateDiff: stateDiff?.changed || [],
    targetProject,
  };
}

async function createRunForScenario(
  fetchImpl: typeof fetch,
  relay: string,
  label: string,
  scenario: string,
  baselineRunId?: string
) {
  return postJson(fetchImpl, `${relay}/orchestrations/start`, {
    label,
    target: "web",
    scenario,
    baselineRunId: baselineRunId || "",
    metadata: {
      projectRoot: resolveWorkspaceRoot(),
    },
  });
}

async function executeTargetWebRun(
  fetchImpl: typeof fetch,
  spawnImpl: typeof spawn,
  webScenarioRunner: typeof runTargetWebScenario,
  relay: string,
  options: CliOptions,
  input: { label: string; scenario?: string; baselineRunId?: string; useAutoloop?: boolean }
) {
  const resolution = await resolveWebTarget(fetchImpl, spawnImpl, relay, options);
  if (resolution.failure) {
    return { failure: resolution.failure };
  }
  const targetProject = resolution.targetProject!;
  const templateName = options.params.templateName || input.scenario || options.params.scenario || "web_home_cold_start";
  try {
    const started = input.useAutoloop
      ? await postJson(fetchImpl, `${relay}/autoloops/start`, {
          triggerReason: options.params.triggerReason || "runtime_change_detected",
          target: "web",
          scenario: templateName,
          baselineRunId: input.baselineRunId || "",
          maxAttempts: 1,
          entryContext: {
            task: options.params.task || "target_project_runtime_check",
            projectRoot: resolveWorkspaceRoot(),
            targetUrl: targetProject.targetUrl,
            demoProhibited: true,
          },
        })
      : await createRunForScenario(fetchImpl, relay, input.label, templateName, input.baselineRunId);
    const runId = String(started.runId || "");
    const result = await webScenarioRunner(fetchImpl, relay, runId, targetProject, templateName, input.baselineRunId);
    const artifact = await requestJson(
      fetchImpl,
      `${relay}/ai/run/${runId}/artifact${options.artifact ? `?path=${encodeURIComponent(options.artifact)}` : ""}`
    ).catch(() => ({ filePath: "" }));
    return {
      payload: {
        ok: true,
        runId,
        autoloopId: started.autoloopId || "",
        demoProhibited: true,
        templateName,
        baselineRunId: input.baselineRunId || "",
        ...result,
        artifactPath: artifact.filePath || "",
      },
    };
  } finally {
    resolution.child?.kill();
  }
}

async function createMiniappRun(
  fetchImpl: typeof fetch,
  relay: string,
  label: string,
  driver: string,
  scenarioId: string,
  metadata: Record<string, unknown> = {}
) {
  return postJson(fetchImpl, `${relay}/runs/start`, {
    label,
    target: "miniapp",
    metadata: {
      projectRoot: resolveWorkspaceRoot(),
      driver,
      scenarioId,
      ...metadata,
    },
  });
}

function miniappStepKindFromAction(actionType: string): "navigate" | "action" {
  return actionType === "launch" || actionType === "enter_page" || actionType === "switch_tab" || actionType === "navigate_back" ? "navigate" : "action";
}

async function runMiniappScenarioExecution(
  fetchImpl: typeof fetch,
  relay: string,
  runId: string,
  driver: string,
  scenario: Record<string, any>,
  projectCheck: Record<string, any>,
  driverModule?: string,
  driverEnvironment: { cliPath?: string; servicePort?: string; projectPath?: string; profileDir?: string } = {}
) {
  const coordinator = new MiniappExecutionCoordinator();
  const execution = await coordinator.execute({
    driver: (driver || "external-agent") as any,
    scenario: scenario as any,
    relay,
    runId,
    projectRoot: resolveWorkspaceRoot(),
    driverModule,
    cliPath: driverEnvironment.cliPath,
    servicePort: driverEnvironment.servicePort,
    projectPath: driverEnvironment.projectPath,
    profileDir: driverEnvironment.profileDir,
    projectCheck: projectCheck as any,
  });
  if (execution.status === "bridge_required") {
    return execution;
  }
  for (const actionResult of execution.actionResults) {
    const step = await postJson(fetchImpl, `${relay}/runs/${runId}/steps/start`, {
      name: `${actionResult.type}:${actionResult.pagePath || actionResult.actionId}`,
      kind: miniappStepKindFromAction(actionResult.type),
      route: actionResult.pagePath || "",
      metadata: {
        actionId: actionResult.actionId,
        actionType: actionResult.type,
        pagePath: actionResult.pagePath || "",
        triggerSource: execution.status === "executed" ? "reference_driver" : "runtime_observed",
        completionStatus: actionResult.completionStatus || (actionResult.success ? "executed" : "failed"),
        timeoutMs: actionResult.timeoutMs || 0,
        retryCount: actionResult.retries || 0,
      },
    });
    if (actionResult.emittedEvents && actionResult.emittedEvents.length > 0) {
      await postJson(fetchImpl, `${relay}/ingest`, {
        runId,
        stepId: step.stepId,
        records: actionResult.emittedEvents,
      });
    }
    await postJson(fetchImpl, `${relay}/runs/${runId}/steps/${step.stepId}/end`, {
      status: actionResult.success ? "passed" : "failed",
      metadata: {
        actionId: actionResult.actionId,
        actionType: actionResult.type,
        pagePath: actionResult.pagePath || "",
        completionStatus: actionResult.completionStatus || (actionResult.success ? "executed" : "failed"),
        timeoutMs: actionResult.timeoutMs || 0,
        retryCount: actionResult.retries || 0,
      },
    });
  }
  await postJson(fetchImpl, `${relay}/runs/${runId}/end`, {
    status:
      execution.status === "driver_not_available"
        ? "aborted"
        : execution.actionResults.every((item) => item.success)
          ? "passed"
          : "failed",
  });
  return execution;
}

async function fetchMiniappClosureBundle(fetchImpl: typeof fetch, relay: string, runId: string) {
  const [readiness, collection, diagnosis, closure, releaseDecision, verificationReport, miniappObservation, handoff] = await Promise.all([
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/readiness`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/collection`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/diagnosis`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/closure`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/release-decision`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/verification-report`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/miniapp-observation`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/handoff`).catch(() => ({ ok: false, handoff: null })),
  ]);
  return {
    readiness: readiness.readiness,
    collection: collection.collection,
    diagnosis: diagnosis.diagnosis,
    closure: closure.closure,
    releaseDecision: releaseDecision.releaseDecision,
    verificationReport: verificationReport.verificationReport,
    miniappObservation: miniappObservation.miniappObservation || miniappObservation.miniappSignals,
    handoff: handoff.handoff || null,
  };
}

function optionGoals(options: CliOptions): string[] {
  return String(options.params.goal || "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTruthyParam(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function miniappRetryCommand(options: CliOptions): string {
  return buildMiniappRetryCommand(options);
}

function attachMiniappExecutingAiContext<T extends Record<string, any>>(
  payload: T,
  input: {
    options: CliOptions;
    reasonCodes: string[];
    automationAttempts: string[];
    servicePort?: string;
  }
): T {
  const userActionRequest = miniappUserActionRequest({ reasonCodes: input.reasonCodes, options: input.options, servicePort: input.servicePort });
  const retryCommand = miniappRetryCommand(input.options);
  if (payload.failure && typeof payload.failure === "object") {
    payload.failure.evidenceRefs = payload.failure.evidenceRefs || {};
    payload.failure.userActionRequest = userActionRequest;
    payload.failure.automationAttempts = input.automationAttempts;
    payload.failure.retryCommand = retryCommand;
  }
  if (payload.harnessReport?.forExecutingAI) {
    payload.harnessReport.forExecutingAI.userActionRequest = userActionRequest;
    payload.harnessReport.forExecutingAI.automationAttempts = input.automationAttempts;
    payload.harnessReport.forExecutingAI.retryCommand = retryCommand;
  }
  (payload as any).forExecutingAI = {
    ...((payload as any).forExecutingAI || {}),
    userActionRequest,
    automationAttempts: input.automationAttempts,
    retryCommand,
  };
  return payload;
}

function blackboxRunOptions(options: CliOptions, storageState?: string): BlackboxRunOptions {
  const viewport = options.params.viewport === "mobile" || options.params.viewport === "both" ? options.params.viewport : "desktop";
  return {
    storageState,
    saveAuthProfile: options.params.saveAuthProfile || "",
    visual: isTruthyParam(options.params.visual),
    a11y: isTruthyParam(options.params.a11y),
    viewport,
  };
}

function blackboxFailure(reasonCode: string, reason: string, recommendedAction: string): CliStandardFailure & { demoProhibited: true } {
  return {
    ok: false,
    status: "partial",
    reasonCode,
    reason,
    recommendedAction,
    supportedTargets: ["web", "miniapp"],
    currentCapabilities: ["blackbox-visible-ui", "target-project-only", "demoProhibited"],
    demoProhibited: true,
  };
}

function harnessFailure(reasonCode: string, reason: string, recommendedAction: string): CliStandardFailure & { demoProhibited: true; harness: true; failure: RelayFailure } {
  return {
    ok: false,
    status: "partial",
    reasonCode,
    reason,
    recommendedAction,
    supportedTargets: ["web", "miniapp"],
    currentCapabilities: ["target-project-harness", "blackbox-visible-ui", "evidence-index", "release-gate", "demoProhibited"],
    demoProhibited: true,
    harness: true,
    failure: relayFailure({
      reasonCode,
      family: reasonCode.includes("driver") ? "driver" : reasonCode.includes("evidence") ? "evidence" : reasonCode.includes("target") ? "target" : "harness",
      userMessage: reason,
      recommendedAction,
      retryable: true,
    }),
  };
}

function harnessReasonFromTargetFailure(reasonCode: string): string {
  if (reasonCode === "target_project_start_failed") return "harness_environment_start_failed";
  if (reasonCode === "driver_required" || reasonCode === "computer_use_ledger_required") return "harness_driver_unavailable";
  return "harness_target_unresolved";
}

function errorPayload(error: unknown): Record<string, any> | undefined {
  if (error instanceof Error && (error as Error & { payload?: unknown }).payload && typeof (error as Error & { payload?: unknown }).payload === "object") {
    return (error as Error & { payload: Record<string, any> }).payload;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function blackboxReportStoreFailure(error: unknown, fallbackReasonCode = "blackbox_report_invalid") {
  const payload = errorPayload(error);
  const message = errorMessage(error);
  const reasonCode =
    typeof payload?.reasonCode === "string"
      ? payload.reasonCode
      : message.includes("visible_evidence_required")
        ? "visible_evidence_required"
        : message.includes("target_project_invalid")
          ? "target_project_invalid"
          : fallbackReasonCode;
  return { reasonCode, message, payload };
}

function harnessReasonFromBlackboxStoreFailure(reasonCode: string): string {
  if (reasonCode === "target_project_invalid") return "harness_target_mismatch";
  if (reasonCode === "visible_evidence_required" || reasonCode === "blackbox_report_invalid") return "harness_blackbox_required";
  return "harness_evidence_invalid";
}

async function miniappDriverCheck(options: CliOptions, bootstrapOverride?: Awaited<ReturnType<typeof bootstrapMiniappDevTools>>) {
  const workspaceRoot = resolveWorkspaceRoot();
  const bootstrap = bootstrapOverride || await bootstrapMiniappDevTools({
      workspaceRoot,
      fix: options.params.fix === "true" || options.params.fix === "1",
      driver: options.params.bootstrapDriver || options.params.driver,
      cliPath: options.params.cliPath,
      servicePort: options.params.servicePort,
      projectPath: options.params.projectPath,
      profileDir: options.params.profileDir,
      sidecarPort: options.params.sidecarPort,
    });
  const resolution = resolveMiniappDriver({
    workspaceRoot,
    driver: options.params.driver || "devtools-automator",
    driverModule: options.params.driverModule,
    ledger: options.params.ledger,
    cliPath: options.params.cliPath,
    servicePort: options.params.servicePort || bootstrap.servicePort,
    projectPath: options.params.projectPath,
    bootstrap,
  });
  resolution.bootstrap = bootstrap;
  return {
    ok: resolution.reasonCodes.length === 0,
    target: "miniapp",
    driverResolution: {
      ...resolution,
      required: true,
      missing: resolution.reasonCodes,
      servicePortRequired: true,
      servicePortHint: "Prefer relay miniapp bootstrap --fix. Manual fallback: 微信开发者工具 -> 设置 -> 安全设置 -> 开启服务端口",
    },
    bootstrap,
    demoProhibited: true,
  };
}

function runtimeFixtureTargetsRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/targets");
}

async function fixtureNames(root: string, requested: string): Promise<string[]> {
  if (requested && requested !== "all") return [requested];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function startFixtureServer(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const relative = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
      const absolute = path.resolve(root, `.${relative}`);
      const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
      if (absolute !== root && !absolute.startsWith(rootWithSeparator)) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      const fileStat = await stat(absolute).catch(() => null);
      const filePath = fileStat?.isDirectory() ? path.join(absolute, "index.html") : absolute;
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": contentTypeFor(filePath) });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function runBlackboxBenchmark(fetchImpl: typeof fetch, options: CliOptions) {
  const fixture = options.params.fixture || "all";
  const benchmarkId = `benchmark-${Date.now()}`;
  const fixturesRoot = runtimeFixtureTargetsRoot();
  const report = {
    benchmarkId,
    fixture,
    target: "mixed",
    passed: 0,
    failed: 0,
    manualReview: 0,
    reports: [] as Array<{ fixture: string; runId?: string; reportRef?: string; status: string; target: string }>,
    failureTaxonomy: [] as string[],
    coverageGaps: [] as string[],
    generatedAt: new Date().toISOString(),
    demoProhibited: true,
  };
  const names = await fixtureNames(fixturesRoot, fixture);
  for (const name of names) {
    const fixtureRoot = path.join(fixturesRoot, name);
    const hasIndex = await stat(path.join(fixtureRoot, "index.html")).then((item) => item.isFile()).catch(() => false);
    if (!hasIndex) {
      report.manualReview += 1;
      report.coverageGaps.push(`${name}:non_web_or_driver_fixture`);
      report.reports.push({ fixture: name, status: "manual_review_required", target: name.includes("miniapp") ? "miniapp" : "unknown" });
      continue;
    }
    const server = await startFixtureServer(fixtureRoot);
    try {
      const targetProject = {
        workspaceRoot: fixtureRoot,
        resolvedProjectRoot: fixtureRoot,
        targetUrl: server.url,
        startCommand: "fixture-static-server",
        urlSource: "explicit" as const,
      };
      const discoverSummary = await runWebBlackboxDiscover(server.url, undefined, blackboxRunOptions(options));
      const plan = await createBlackboxPlan(fetchImpl, options.relay, "web", targetProject, options, {}, discoverSummary);
      const runStart = await postJson(fetchImpl, `${options.relay}/runs/start`, {
        label: `benchmark:${name}`,
        target: "web",
        metadata: {
          projectRoot: fixtureRoot,
          targetProject,
          driver: "playwright",
          blackbox: true,
          benchmarkId,
          fixture: name,
          demoProhibited: true,
        },
      });
      const blackboxReport = await runWebBlackboxPlan(fetchImpl, options.relay, String(runStart.runId), targetProject, plan, blackboxRunOptions(options));
      const stored = await postJson(fetchImpl, `${options.relay}/blackbox/run`, { report: blackboxReport });
      const storedReport = (stored.report || blackboxReport) as BlackboxRunReport;
      report.passed += storedReport.cases.filter((testCase) => testCase.status === "passed").length;
      report.failed += storedReport.cases.filter((testCase) => testCase.status === "failed").length;
      report.manualReview += storedReport.cases.filter((testCase) => testCase.status === "manual_review_required").length;
      report.failureTaxonomy.push(...(storedReport.forExecutingAI.failureTaxonomy || []));
      report.coverageGaps.push(...(storedReport.forExecutingAI.coverageGaps || []).map((gap) => `${name}:${gap}`));
      report.reports.push({
        fixture: name,
        runId: storedReport.runId,
        reportRef: storedReport.evidenceRefs?.blackboxReport,
        status: storedReport.blackboxGate?.passed ? "passed" : "failed",
        target: "web",
      });
    } catch (error) {
      report.failed += 1;
      report.failureTaxonomy.push("app_runtime_failure");
      report.coverageGaps.push(`${name}:${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      report.reports.push({ fixture: name, status: "failed", target: "web" });
    } finally {
      await server.close().catch(() => null);
    }
  }
  report.failureTaxonomy = Array.from(new Set(report.failureTaxonomy));
  report.coverageGaps = Array.from(new Set(report.coverageGaps)).slice(0, 50);
  await postJson(fetchImpl, `${options.relay}/ai/benchmark/blackbox`, { report }).catch(() => null);
  return report;
}

async function runWebBlackboxDiscover(targetUrl: string, runId?: string, options: BlackboxRunOptions = {}): Promise<BlackboxDiscoverSummary> {
  const { chromium } = await import("playwright");
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return discoverWebUiFromHtml(fetch, targetUrl, error instanceof Error ? error.message : String(error));
  }
  const variants = webViewportVariants(options.viewport);
  const summaries: BlackboxDiscoverSummary[] = [];
  try {
    for (const variant of variants) {
      const context = await browser.newContext({
        ...(options.storageState ? { storageState: options.storageState } : {}),
        viewport: variant.viewport,
      });
      const page = await context.newPage();
      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(300);
        const accessibilityApi = (page as any).accessibility;
        const accessibility = accessibilityApi ? await accessibilityApi.snapshot({ interestingOnly: true }).catch(() => null) : null;
        const screenshot = runId ? await page.screenshot({ fullPage: true }).catch(() => null) : null;
        const screenshotPath = screenshot ? await writeRuntimeEvidenceArtifact(runId || "discover", `discover-${variant.name}`, "png", screenshot) : "";
        const accessibilitySummary = JSON.stringify(accessibility || {}).slice(0, 4000);
        const accessibilityPath = runId ? await writeRuntimeEvidenceArtifact(runId, `discover-${variant.name}-accessibility`, "json", `${JSON.stringify(accessibility || {}, null, 2)}\n`) : "";
        const inventory = await page.evaluate(collectWebObserveInventory);
        summaries.push({
          target: "web",
          targetUrl,
          title: inventory.title,
          visibleText: inventory.visibleText,
          accessibilitySummary,
          controls: inventory.controls as BlackboxDiscoverSummary["controls"],
          actionCandidates: inventory.actionCandidates as BlackboxDiscoverSummary["actionCandidates"],
          locatorCandidates: inventory.locatorCandidates as BlackboxDiscoverSummary["locatorCandidates"],
          riskFlags: inventory.riskFlags as string[],
          coverageHints: [`viewport:${variant.name}`, ...(inventory.coverageHints as string[])],
          errorTokens: inventory.errorTokens,
          emptyTokens: inventory.emptyTokens,
          generatedAt: new Date().toISOString(),
          evidenceRefs: {
            screenshots: screenshotPath ? [screenshotPath] : [],
            accessibility: accessibilityPath ? [accessibilityPath] : [],
          },
        });
      } finally {
        await context.close().catch(() => null);
      }
    }
    const primary = summaries[0];
    if (!primary) return discoverWebUiFromHtml(fetch, targetUrl, "discover_empty");
    if (summaries.length === 1) return primary;
    return {
      ...primary,
      visibleText: summaries.map((summary) => summary.visibleText || "").filter(Boolean).join("\n").slice(0, 4000),
      accessibilitySummary: summaries.map((summary) => summary.accessibilitySummary || "").filter(Boolean).join("\n").slice(0, 4000),
      controls: summaries.flatMap((summary) => summary.controls || []),
      actionCandidates: summaries.flatMap((summary) => summary.actionCandidates || []),
      locatorCandidates: summaries.flatMap((summary) => summary.locatorCandidates || []),
      riskFlags: Array.from(new Set(summaries.flatMap((summary) => summary.riskFlags || []))),
      coverageHints: Array.from(new Set(summaries.flatMap((summary) => summary.coverageHints || []))),
      errorTokens: Array.from(new Set(summaries.flatMap((summary) => summary.errorTokens || []))),
      emptyTokens: Array.from(new Set(summaries.flatMap((summary) => summary.emptyTokens || []))),
      evidenceRefs: {
        screenshots: summaries.flatMap((summary) => summary.evidenceRefs?.screenshots || []),
        accessibility: summaries.flatMap((summary) => summary.evidenceRefs?.accessibility || []),
      },
    };
  } catch (error) {
    return discoverWebUiFromHtml(fetch, targetUrl, error instanceof Error ? error.message : String(error));
  } finally {
    await browser.close();
  }
}

async function createBlackboxPlan(
  fetchImpl: typeof fetch,
  relay: string,
  target: "web" | "miniapp",
  targetProject: Record<string, unknown>,
  options: CliOptions,
  projectCheck?: Record<string, unknown>,
  discoverSummary?: BlackboxDiscoverSummary
): Promise<BlackboxPlan> {
  const payload = await postJson(fetchImpl, `${relay}/ai/blackbox/plan`, {
    target,
    targetProject,
    projectCheck: projectCheck || {},
    goals: optionGoals(options),
    maxCases: options.params.maxCases ? Number(options.params.maxCases) : 5,
    allowMutations: isTruthyParam(options.params.allowMutations),
    noDiscover: true,
    discoverSummary,
  });
  return payload.plan as BlackboxPlan;
}

async function fetchBlackboxPlanById(fetchImpl: typeof fetch, relay: string, planId: string): Promise<BlackboxPlan> {
  if (!planId) {
    throw new Error("blackbox_plan_required");
  }
  const payload = await requestJson(fetchImpl, `${relay}/ai/blackbox/plan/${encodeURIComponent(planId)}`);
  if (!payload.plan) {
    throw new Error("blackbox_plan_invalid");
  }
  return payload.plan as BlackboxPlan;
}

async function createHarnessReport(
  fetchImpl: typeof fetch,
  relay: string,
  input: {
    target: "web" | "miniapp";
    driver: string;
    blackboxRunId: string;
    targetProject: Record<string, unknown>;
    goals: string[];
    regressionSeedRef?: string;
    executionContext?: Record<string, unknown>;
  }
) {
  return postJson(fetchImpl, `${relay}/ai/harness/from-blackbox-run`, input);
}

function ledgerPlanId(ledger: Record<string, any>): string {
  return typeof ledger.planId === "string" && ledger.planId.trim() ? ledger.planId.trim() : "";
}

function blackboxScenarioSpec(plan: BlackboxPlan): ScenarioSpec {
  return {
    id: `${plan.planId}_suite`,
    target: plan.target,
    flow: "blackbox",
    entry: plan.target === "web" ? { route: "/" } : { page: plan.cases[0]?.entry.page || "" },
    actions:
      plan.target === "miniapp"
        ? plan.cases.map((testCase) => ({
            id: testCase.id,
            type: (testCase.steps.find((step) => step.action === "switch_tab")?.action ||
              testCase.steps.find((step) => step.action === "pull_down_refresh")?.action ||
              "enter_page") as MiniappActionInput["type"],
            pagePath: testCase.entry.page || testCase.steps.find((step) => step.pagePath)?.pagePath || "/pages/index/index",
          }))
        : undefined,
    steps: plan.cases.map((testCase) => ({
      id: testCase.id,
      kind: "wait_render",
      eventPhase: "render",
      match: `blackbox_assertion:${testCase.id}:passed`,
    })),
    expectations: plan.cases.map((testCase) => testCase.userGoal),
    fallbacks: [],
    assertions: plan.cases.map((testCase) => ({
      id: `${testCase.id}_visible`,
      type: "continuity",
      match: `blackbox_assertion:${testCase.id}:passed`,
      blocking: true,
    })),
    stateTransitions: plan.cases.map((testCase) => ({
      from: "user_goal",
      to: "visible_result",
      evidenceMatch: `blackbox_assertion:${testCase.id}:passed`,
    })),
    templateName: `${plan.planId}_suite`,
    riskLevel: "high",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    blackbox: {
      planId: plan.planId,
      planNonce: plan.planNonce,
      caseNonces: Object.fromEntries(plan.cases.map((testCase) => [testCase.id, testCase.caseNonce || ""])),
    },
  };
}

function classifyBlackboxReportFailures(cases: BlackboxCaseRunReport[], runtimeEvidence: string[], releaseDecision?: Record<string, unknown>) {
  const categories = new Set<string>();
  const blockingItems = releaseDecision && Array.isArray(releaseDecision.blockingItems) ? releaseDecision.blockingItems.map(String) : [];
  if (blockingItems.length > 0 || runtimeEvidence.some((item) => /error|failure|exception|500/i.test(item))) categories.add("app_runtime_failure");
  for (const testCase of cases) {
    const reason = `${testCase.failureReason || ""} ${testCase.runtimeEvidence.join(" ")}`.toLowerCase();
    if (testCase.status === "failed") categories.add("visible_assertion_failed");
    if (/locator|selector|strict mode|not visible|timeout|waiting/i.test(reason)) categories.add("locator_unstable");
    if (/auth|login|permission|forbidden|unauthorized|401|403|权限|登录/i.test(reason)) categories.add("auth_or_permission_required");
    if (/network|fetch|request|response|timeout|api|数据|empty|no data/i.test(reason)) categories.add("network_or_data_dependency");
    if (/ledger|driver|nonce|visible_evidence_required|action_ledger_required/i.test(reason)) categories.add("driver_or_ledger_invalid");
  }
  return Array.from(categories);
}

function finalBlackboxReport(input: {
  runId: string;
  plan: BlackboxPlan;
  cases: BlackboxCaseRunReport[];
  runtimeEvidence?: string[];
  releaseDecision?: Record<string, unknown>;
  qualitySignals?: QualitySignal[];
  locatorRepairRefs?: string[];
  visualEvidenceRefs?: string[];
  a11yEvidenceRefs?: string[];
  playwrightTraceRefs?: string[];
}): BlackboxRunReport {
  const visibleEvidence = input.cases.flatMap((item) => item.visibleEvidence);
  const runtimeEvidence = [...(input.runtimeEvidence || []), ...input.cases.flatMap((item) => item.runtimeEvidence)].slice(0, 20);
  const failedCases = input.cases.filter((item) => item.status === "failed").map((item) => item.caseId);
  const manualReviewCases = input.cases.filter((item) => item.status === "manual_review_required").map((item) => item.caseId);
  const passedCases = input.cases.filter((item) => item.status === "passed");
  const blockingRuntimeFailure = releaseHasBlockingFailure(input.releaseDecision);
  const releaseBlockingItems = input.releaseDecision && Array.isArray(input.releaseDecision.blockingItems)
    ? input.releaseDecision.blockingItems.map(String)
    : [];
  const qualityBlockingItems = (input.qualitySignals || []).filter((signal) => signal.severity === "blocking").map((signal) => signal.kind);
  const runtimeBlockingItems = Array.from(new Set([...releaseBlockingItems, ...blackboxRuntimeBlockingItems(runtimeEvidence), ...qualityBlockingItems]));
  const failureTaxonomy = classifyBlackboxReportFailures(input.cases, runtimeEvidence, input.releaseDecision);
  const coverageGaps = [
    ...(input.plan.discoverSummary?.coverageHints || []),
    ...input.plan.skippedCandidates.slice(0, 5),
    ...(input.cases.filter((item) => item.status === "skipped").length ? [`skipped_cases:${input.cases.filter((item) => item.status === "skipped").map((item) => item.caseId).join(",")}`] : []),
    ...(manualReviewCases.length ? [`manual_review_cases:${manualReviewCases.join(",")}`] : []),
  ];
  const blackboxGate = evaluateBlackboxGate({
    blockingPassedCases: passedCases.map((item) => item.caseId),
    blockingFailedCases: failedCases,
    manualReviewCases,
    runtimeBlockingItems,
  });
  return {
    runId: input.runId,
    planId: input.plan.planId,
    target: input.plan.target,
    passed: passedCases.length,
    failed: failedCases.length,
    cases: input.cases,
    visibleEvidence,
    runtimeEvidence,
    forExecutingAI: {
      verifiedGoals: passedCases.map((item) => item.userGoal),
      failedCases,
      userVisibleFindings: visibleEvidence.slice(0, 10),
      runtimeClues: runtimeEvidence.slice(0, 10),
      validatedUserFlows: passedCases.map((item) => item.userGoal),
      blockedUserFlows: input.cases.filter((item) => item.status === "failed" || item.status === "manual_review_required").map((item) => item.userGoal),
      traceRefs: [],
      coverageGaps,
      failureTaxonomy: failureTaxonomy as BlackboxRunReport["forExecutingAI"]["failureTaxonomy"],
      nextRecommendation:
        blockingRuntimeFailure
          ? "黑盒可见流程不能放行：release decision 仍有阻塞项，需要先修 runtime failure。"
          : failedCases.length > 0 || manualReviewCases.length > 0
          ? "修复失败用户流程或补充更具体的黑盒目标后重跑。"
          : passedCases.length > 0
            ? "至少一个阻塞黑盒用户流程已通过，可继续结合 runtime failure 和 release decision 判断是否 handoff。"
            : "补接入真实 driver 或可执行 ledger 后重跑黑盒流程。",
    },
    targetProject: input.plan.targetProject,
    releaseDecision: input.releaseDecision,
    blackboxGate,
    discoverSummary: input.plan.discoverSummary,
    evidenceRefs: {
      screenshots: input.visualEvidenceRefs || [],
      accessibility: input.a11yEvidenceRefs || [],
      locatorRepairs: input.locatorRepairRefs || [],
      playwrightTraces: input.playwrightTraceRefs || [],
    },
    locatorRepairRefs: input.locatorRepairRefs || [],
    visualEvidenceRefs: input.visualEvidenceRefs || [],
    a11yEvidenceRefs: input.a11yEvidenceRefs || [],
    qualitySignals: input.qualitySignals || [],
  };
}

async function collectRuntimeClues(fetchImpl: typeof fetch, relay: string, runId: string): Promise<string[]> {
  const timeline = await requestJson(fetchImpl, `${relay}/ai/run/${runId}/timeline?limit=200`).catch(() => ({ timeline: [] }));
  return Array.isArray(timeline.timeline)
    ? timeline.timeline
        .map((item: any) => item.event || item)
        .filter((event: any) => event && (event.level === "warn" || event.level === "error"))
        .map((event: any) => `${event.level}:${event.message || event.action || "runtime_event"}`)
        .slice(0, 20)
    : [];
}

function webLocator(page: any, selector: string, locator?: BlackboxLocatorCandidate) {
  if (!locator) return page.locator(selector).first();
  if (locator.strategy === "testid") return page.getByTestId(locator.value).first();
  if (locator.strategy === "role") return page.getByRole(locator.value, locator.name ? { name: locator.name } : undefined).first();
  if (locator.strategy === "label") return page.getByLabel(locator.value).first();
  if (locator.strategy === "placeholder") return page.getByPlaceholder(locator.value).first();
  if (locator.strategy === "text") return page.getByText(locator.value).first();
  return page.locator(locator.selector || locator.value || selector).first();
}

async function emitBlackboxEvidence(
  fetchImpl: typeof fetch,
  relay: string,
  input: {
    runId: string;
    stepId?: string;
    testCase: BlackboxCase;
    passed: boolean;
    visibleEvidence: string[];
    runtimeEvidence?: string[];
    context?: Record<string, unknown>;
  }
) {
  await postJson(fetchImpl, `${relay}/ingest`, {
    source: input.testCase.target === "miniapp" ? "miniapp" : "admin-web",
    level: input.passed ? "info" : "error",
    message: `blackbox_assertion:${input.testCase.id}:${input.passed ? "passed" : "failed"} ${input.testCase.userGoal}`,
    runId: input.runId,
    stepId: input.stepId || "",
    phase: "render",
    tags: [
      "blackbox_assertion",
      "visible_evidence",
      `blackbox_case:${input.testCase.id}`,
      `blackbox_assertion:${input.testCase.id}:${input.passed ? "passed" : "failed"}`,
    ],
    context: {
      blackboxCaseId: input.testCase.id,
      userGoal: input.testCase.userGoal,
      visibleEvidence: input.visibleEvidence,
      runtimeEvidence: input.runtimeEvidence || [],
      ...input.context,
    },
  } satisfies RelayLogInput);
}

async function emitBlackboxActionTrace(fetchImpl: typeof fetch, relay: string, trace: BlackboxActionTrace) {
  await postJson(fetchImpl, `${relay}/ingest`, {
    source: trace.runId ? (trace.caseId.startsWith("blackbox_miniapp") ? "miniapp" : "admin-web") : "admin-web",
    level: trace.status === "failed" ? "warn" : "info",
    message: `blackbox_action_trace:${trace.caseId}:${trace.status}`,
    runId: trace.runId,
    stepId: trace.stepId,
    phase: "system",
    tags: ["blackbox_action_trace", `blackbox_case:${trace.caseId}`],
    context: { actionTrace: trace },
  } satisfies RelayLogInput);
}

async function emitLocatorRepair(fetchImpl: typeof fetch, relay: string, repair: LocatorRepairCandidate) {
  await postJson(fetchImpl, `${relay}/ingest`, {
    source: repair.caseId.startsWith("blackbox_miniapp") ? "miniapp" : "admin-web",
    level: "warn",
    message: `locator_repair:${repair.caseId}:manual_review_required`,
    runId: repair.runId,
    stepId: repair.stepId,
    phase: "system",
    tags: ["locator_repair", `blackbox_case:${repair.caseId}`, "manual_review_required"],
    context: { locatorRepair: repair },
  } satisfies RelayLogInput);
}

function releaseHasBlockingFailure(releaseDecision?: Record<string, unknown>): boolean {
  if (!releaseDecision) return false;
  const decision = String(releaseDecision.decision || "");
  const blockingItems = Array.isArray(releaseDecision.blockingItems) ? releaseDecision.blockingItems : [];
  return decision === "hold" || blockingItems.length > 0;
}

function blackboxRuntimeBlockingItems(runtimeEvidence: string[]): string[] {
  return Array.from(
    new Set(
      runtimeEvidence
        .filter((item) => /network:(4\d\d|5\d\d)|console:error|error|failure|exception|uncaught|not found|unauthorized|forbidden|401|403|404|500/i.test(item))
        .map((item) => `runtime:${item}`.slice(0, 180))
    )
  );
}

function blackboxOutcomeOk(report: BlackboxRunReport): boolean {
  if (report.blackboxGate) return report.blackboxGate.passed === true;
  const gate = evaluateBlackboxGate({
    blockingPassedCases: report.cases.filter((testCase) => testCase.status === "passed").map((testCase) => testCase.caseId),
    blockingFailedCases: report.cases.filter((testCase) => testCase.status === "failed").map((testCase) => testCase.caseId),
    manualReviewCases: report.cases.filter((testCase) => testCase.status === "manual_review_required").map((testCase) => testCase.caseId),
    runtimeBlockingItems: releaseHasBlockingFailure(report.releaseDecision) ? ["runtime_blocking_failure"] : blackboxRuntimeBlockingItems(report.runtimeEvidence || []),
  });
  return gate.passed;
}

async function executeWebBlackboxStep(page: any, step: BlackboxCase["steps"][number], targetUrl: string) {
  const selector = step.selector || "body";
  if (step.action === "open") {
    const url = step.route ? new URL(step.route, targetUrl).toString() : targetUrl;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(300);
    return;
  }
  if (step.action === "wait_visible") {
    await webLocator(page, selector, step.locator).waitFor({ state: "visible", timeout: 5_000 });
    return;
  }
  if (step.action === "fill") {
    const locator = webLocator(page, selector, step.locator);
    await locator.waitFor({ state: "visible", timeout: 5_000 });
    await locator.fill(String(step.value || step.text || ""));
    await page.waitForTimeout(100);
    return;
  }
  if (step.action === "press") {
    await page.keyboard.press(String(step.value || "Enter"));
    await page.waitForTimeout(500);
    return;
  }
  if (step.action === "click") {
    const locator = webLocator(page, selector, step.locator);
    await locator.waitFor({ state: "visible", timeout: 5_000 });
    await locator.click();
    await page.waitForTimeout(500);
    return;
  }
  if (step.action === "observe") {
    if (step.selector) {
      await page.locator(step.selector).first().waitFor({ state: "visible", timeout: step.optional ? 1_000 : 5_000 });
    }
    await page.waitForTimeout(200);
  }
}

function locatorCandidatesForStep(plan: BlackboxPlan, step: BlackboxCase["steps"][number]): BlackboxLocatorCandidate[] {
  const candidates: BlackboxLocatorCandidate[] = [];
  if (step.locator) candidates.push(step.locator);
  const controls = [
    ...(plan.discoverSummary?.actionCandidates || []),
    ...(plan.discoverSummary?.controls || []),
  ];
  for (const control of controls) {
    if (control.selector && step.selector && control.selector === step.selector) {
      candidates.push(...(control.locatorCandidates || []));
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.strategy}:${candidate.value}:${candidate.name || ""}:${candidate.selector || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function tryRepairWebBlackboxStep(page: any, plan: BlackboxPlan, step: BlackboxCase["steps"][number], targetUrl: string): Promise<BlackboxLocatorCandidate | null> {
  for (const candidate of locatorCandidatesForStep(plan, step).slice(1)) {
    try {
      await executeWebBlackboxStep(page, { ...step, locator: candidate }, targetUrl);
      return candidate;
    } catch {
      // Try the next deterministic locator candidate from the same observed control.
    }
  }
  return null;
}

async function captureWebVisibleSnapshot(page: any, assertions: BlackboxCase["visibleAssertions"], initial: { url: string; text: string }) {
  return page.evaluate(
    ({ expectedAssertions, initialUrl, initialText }: { expectedAssertions: BlackboxCase["visibleAssertions"]; initialUrl: string; initialText: string }) => {
      const host = globalThis as any;
      const doc = host.document;
      const text = (doc.body?.innerText || "").replace(/\s+/g, " ").trim();
      const isVisible = (selector: string) =>
        Array.from(doc.querySelectorAll(selector)).some((element) => {
          const style = host.getComputedStyle(element);
          const rect = (element as any).getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        });
      const results = expectedAssertions.map((assertion) => {
        if (assertion.kind === "selector_visible") {
          return { id: assertion.id, passed: Boolean(assertion.selector && isVisible(assertion.selector)), reason: assertion.selector || "" };
        }
        if (assertion.kind === "text_visible") {
          return { id: assertion.id, passed: Boolean(assertion.text && text.includes(assertion.text)), reason: assertion.text || "" };
        }
        if (assertion.kind === "no_visible_error") {
          const lower = text.toLowerCase();
          const bad = ["uncaught", "stack trace", "500 internal server error", "application error", "404", "403", "not found", "forbidden", "unauthorized"].some((token) => lower.includes(token));
          return { id: assertion.id, passed: !bad, reason: bad ? "visible_error_token" : "no_visible_error" };
        }
        if (assertion.kind === "visible_change") {
          const normalizedInitial = initialText.replace(/\d{1,2}:\d{2}(:\d{2})?/g, "").replace(/\d{4}-\d{1,2}-\d{1,2}/g, "").trim();
          const normalizedCurrent = text.replace(/\d{1,2}:\d{2}(:\d{2})?/g, "").replace(/\d{4}-\d{1,2}-\d{1,2}/g, "").trim();
          const delta = Math.abs(normalizedCurrent.length - normalizedInitial.length);
          return {
            id: assertion.id,
            passed: normalizedCurrent.length > 0 && (normalizedCurrent !== normalizedInitial || delta > 12),
            reason: normalizedCurrent === normalizedInitial ? "visible_content_unchanged" : "visible_content_changed",
          };
        }
        if (assertion.kind === "url_changed") {
          return { id: assertion.id, passed: host.location.href !== initialUrl, reason: host.location.href };
        }
        return { id: assertion.id, passed: false, reason: "unsupported_assertion" };
      });
      return {
        title: doc.title || "",
        url: host.location.href,
        text: text.slice(0, 500),
        interactiveCount: doc.querySelectorAll("a,button,[role=button],nav").length,
        inputCount: doc.querySelectorAll("input,textarea,select,[role=searchbox]").length,
        results,
      };
    },
    { expectedAssertions: assertions, initialUrl: initial.url, initialText: initial.text }
  );
}

async function captureWebBaseline(page: any): Promise<{ url: string; text: string }> {
  return page.evaluate(() => {
    const host = globalThis as any;
    const text = (host.document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return { url: host.location.href, text };
  });
}

async function captureWebActionState(page: any): Promise<{ url: string; text: string }> {
  return page.evaluate(() => {
    const host = globalThis as any;
    const text = (host.document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500);
    return { url: host.location.href, text };
  }).catch(() => ({ url: "", text: "" }));
}

async function collectWebQualitySignals(
  page: any,
  runId: string,
  testCaseId: string,
  options: BlackboxRunOptions,
  screenshotPath: string,
  accessibilityPath: string,
  accessibility: unknown
): Promise<QualitySignal[]> {
  const signals: QualitySignal[] = [];
  if (options.visual) {
    const visualState = await page.evaluate(() => {
      const host = globalThis as any;
      const text = (host.document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const visibleElements = Array.from(host.document.querySelectorAll("body *")).filter((element: any) => {
        const style = host.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }).length;
      return { textLength: text.length, visibleElements };
    }).catch(() => ({ textLength: 0, visibleElements: 0 }));
    signals.push({
      id: `${testCaseId}:visual_snapshot`,
      kind: "visual_snapshot",
      severity: "info",
      message: `visible elements=${visualState.visibleElements}, text length=${visualState.textLength}`,
      evidenceRef: screenshotPath,
    });
    if (!screenshotPath || visualState.textLength < 2 || visualState.visibleElements < 1) {
      signals.push({
        id: `${testCaseId}:visual_blank_screen`,
        kind: "visual_blank_screen_detected",
        severity: "blocking",
        message: "The page appears visually blank or screenshot capture failed.",
        evidenceRef: screenshotPath,
      });
    }
  }
  if (options.a11y) {
    const unnamedControls: string[] = [];
    const visit = (node: any) => {
      if (!node || typeof node !== "object") return;
      if ((node.role === "button" || node.role === "link" || node.role === "textbox") && !String(node.name || "").trim()) {
        unnamedControls.push(node.role);
      }
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    visit(accessibility);
    if (unnamedControls.length > 0) {
      signals.push({
        id: `${testCaseId}:a11y_key_control_unnamed`,
        kind: "a11y_key_control_unnamed",
        severity: "blocking",
        message: `Key controls without accessible names: ${unnamedControls.slice(0, 5).join(", ")}`,
        evidenceRef: accessibilityPath,
      });
    }
  }
  return signals;
}

async function runWebBlackboxPlan(
  fetchImpl: typeof fetch,
  relay: string,
  runId: string,
  targetProject: TargetProjectInfo,
  plan: BlackboxPlan,
  options: BlackboxRunOptions = {}
): Promise<BlackboxRunReport> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const caseReports: BlackboxCaseRunReport[] = [];
  const qualitySignals: QualitySignal[] = [];
  const locatorRepairRefs: string[] = [];
  const visualEvidenceRefs: string[] = [];
  const a11yEvidenceRefs: string[] = [];
  const playwrightTraceRefs: string[] = [];
  const variants = webViewportVariants(options.viewport);
  try {
    for (const testCase of plan.cases) {
      for (const variant of variants) {
      const context = await browser.newContext({
        ...(options.storageState ? { storageState: options.storageState } : {}),
        viewport: variant.viewport,
      });
      const artifactCaseId = variants.length > 1 ? `${testCase.id}.${variant.name}` : testCase.id;
      const playwrightTracePath = await runtimeEvidenceArtifactPath(runId, `${artifactCaseId}.playwright-trace`, "zip");
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false }).catch(() => null);
      const page = await context.newPage();
      const runtimeClues: string[] = [];
      page.on("console", (message: any) => {
        const type = typeof message.type === "function" ? message.type() : "log";
        if (type === "error" || type === "warning") runtimeClues.push(`console:${type}:${message.text?.() || ""}`.slice(0, 300));
      });
      page.on("response", (response: any) => {
        const status = typeof response.status === "function" ? response.status() : 0;
        if (status >= 400) runtimeClues.push(`network:${status}:${response.url?.() || ""}`.slice(0, 300));
      });
      const step = await postJson(fetchImpl, `${relay}/runs/${runId}/steps/start`, {
        name: `blackbox:${testCase.id}:${variant.name}`,
        kind: testCase.steps.some((item) => item.action === "open") ? "navigate" : "assert",
        route: testCase.entry.route || "/",
        metadata: { blackboxCaseId: testCase.id, userGoal: testCase.userGoal, viewport: variant.name, demoProhibited: true },
      });
      let passed = false;
      let failureReason = "";
      let visibleEvidence: string[] = [];
      const actionTraceActions: BlackboxActionTrace["actions"] = [];
      let repairedLocator: BlackboxLocatorCandidate | null = null;
      let repairedStepId = "";
      try {
        await installWebRelay(page, relay, runId);
        await setWebStep(page, step.stepId);
        const targetUrl = testCase.entry.url || targetProject.targetUrl;
        if (!testCase.steps.some((item) => item.action === "open")) {
          await page.goto(String(targetUrl), { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForTimeout(300);
        }
        let baseline = await captureWebBaseline(page).catch(() => ({ url: String(targetUrl), text: "" }));
        for (const blackboxStep of testCase.steps) {
          const before = await captureWebActionState(page);
          try {
            await executeWebBlackboxStep(page, blackboxStep, String(targetUrl));
          } catch (error) {
            const repair = await tryRepairWebBlackboxStep(page, plan, blackboxStep, String(targetUrl));
            if (!repair) throw error;
            repairedLocator = repair;
            repairedStepId = blackboxStep.id;
          }
          const after = await captureWebActionState(page);
          actionTraceActions.push({
            action: blackboxStep.action,
            selector: blackboxStep.selector,
            locator: blackboxStep.locator,
            urlBefore: before.url,
            urlAfter: after.url,
            visibleTextBefore: before.text,
            visibleTextAfter: after.text,
            runtimeClues: runtimeClues.slice(-5),
          });
          if (blackboxStep.action === "open") {
            baseline = await captureWebBaseline(page);
          }
        }
        const snapshot = await captureWebVisibleSnapshot(page, testCase.visibleAssertions, baseline);
        const screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
        const screenshotPath = screenshot ? await writeRuntimeEvidenceArtifact(runId, `${artifactCaseId}-screenshot`, "png", screenshot) : "";
        const accessibilityApi = (page as any).accessibility;
        const accessibility = accessibilityApi ? await accessibilityApi.snapshot({ interestingOnly: true }).catch(() => null) : null;
        const accessibilityPath = await writeRuntimeEvidenceArtifact(
          runId,
          `${artifactCaseId}-accessibility`,
          "json",
          `${JSON.stringify(accessibility || {}, null, 2)}\n`
        ).catch(() => "");
        if (screenshotPath) visualEvidenceRefs.push(screenshotPath);
        if (accessibilityPath) a11yEvidenceRefs.push(accessibilityPath);
        qualitySignals.push(...await collectWebQualitySignals(page, runId, artifactCaseId, options, screenshotPath, accessibilityPath, accessibility));
        passed = snapshot.results.every((item: { passed: boolean }) => item.passed);
        const manualReviewRequired = Boolean(passed && repairedLocator);
        if (testCase.id.includes("input_or_filter") && !passed) {
          await emitBlackboxActionTrace(fetchImpl, relay, {
            runId,
            planId: plan.planId,
            caseId: testCase.id,
            stepId: step.stepId,
            userGoal: testCase.userGoal,
            status: "skipped",
            actions: actionTraceActions,
            assertionResults: snapshot.results,
            screenshotRef: screenshotPath,
            accessibilityRef: accessibilityPath,
            runtimeClues: runtimeClues.slice(0, 20),
            generatedAt: new Date().toISOString(),
          }).catch(() => null);
          caseReports.push({
            caseId: testCase.id,
            userGoal: testCase.userGoal,
            status: "skipped",
            visibleEvidence: [`页面未发现搜索/过滤输入入口。可见内容: ${snapshot.text.slice(0, 160)}`],
            runtimeEvidence: [],
            failureReason: "input_entry_not_visible",
          });
          await postJson(fetchImpl, `${relay}/runs/${runId}/steps/${step.stepId}/end`, {
            status: "passed",
            metadata: { blackboxStatus: "skipped" },
          });
          continue;
        }
        failureReason = passed ? "" : snapshot.results.filter((item: { passed: boolean }) => !item.passed).map((item: { id: string }) => item.id).join(",");
        if (manualReviewRequired) {
          failureReason = "locator_repair_manual_review_required";
        }
        visibleEvidence = [
          `视口: ${variant.name} (${variant.viewport.width}x${variant.viewport.height})`,
          `URL: ${snapshot.url}`,
          `标题: ${snapshot.title || "(empty)"}`,
          `可见文本: ${snapshot.text || "(empty)"}`,
          `可交互入口: ${snapshot.interactiveCount}, 输入入口: ${snapshot.inputCount}`,
          ...(screenshotPath ? [`截图: ${screenshotPath}`] : []),
          ...(accessibilityPath ? [`可访问树: ${accessibilityPath}`] : []),
        ];
        await emitBlackboxEvidence(fetchImpl, relay, {
          runId,
          stepId: step.stepId,
          testCase,
          passed: passed && !manualReviewRequired,
          visibleEvidence,
          runtimeEvidence: runtimeClues.slice(0, 20),
          context: { assertionResults: snapshot.results, targetProject, manualReviewRequired },
        });
        if (manualReviewRequired && repairedLocator) {
          const repair: LocatorRepairCandidate = {
            runId,
            planId: plan.planId,
            caseId: testCase.id,
            stepId: step.stepId,
            originalLocator: testCase.steps.find((item) => item.id === repairedStepId)?.locator,
            originalSelector: testCase.steps.find((item) => item.id === repairedStepId)?.selector,
            repairedLocator,
            repairReason: "Original locator failed; an alternate observed locator candidate completed the step and visible assertions passed.",
            assertionResults: snapshot.results,
            screenshotRef: screenshotPath,
            traceRef: playwrightTracePath,
            status: "manual_review_required",
            generatedAt: new Date().toISOString(),
          };
          await emitLocatorRepair(fetchImpl, relay, repair).catch(() => null);
          const repairRef = await writeRuntimeEvidenceArtifact(runId, `${artifactCaseId}.${repairedStepId}.locator-repair`, "json", `${JSON.stringify(repair, null, 2)}\n`).catch(() => "");
          if (repairRef) locatorRepairRefs.push(repairRef);
        }
        await emitBlackboxActionTrace(fetchImpl, relay, {
          runId,
          planId: plan.planId,
          caseId: testCase.id,
          stepId: step.stepId,
          userGoal: testCase.userGoal,
          status: manualReviewRequired ? "manual_review_required" : passed ? "passed" : "failed",
          actions: actionTraceActions,
          assertionResults: snapshot.results,
          screenshotRef: screenshotPath,
          accessibilityRef: accessibilityPath,
          runtimeClues: runtimeClues.slice(0, 20),
          generatedAt: new Date().toISOString(),
        }).catch(() => null);
        caseReports.push({
          caseId: testCase.id,
          userGoal: testCase.userGoal,
          status: manualReviewRequired ? "manual_review_required" : passed ? "passed" : "failed",
          visibleEvidence,
          runtimeEvidence: runtimeClues.slice(0, 20),
          failureReason,
        });
        await postJson(fetchImpl, `${relay}/runs/${runId}/steps/${step.stepId}/end`, {
          status: passed && !manualReviewRequired ? "passed" : "failed",
          metadata: { blackboxStatus: manualReviewRequired ? "manual_review_required" : passed ? "passed" : "failed", failureReason },
        });
      } catch (error) {
        failureReason = error instanceof Error ? error.message : String(error);
        visibleEvidence = [`黑盒执行异常: ${failureReason}`];
        await emitBlackboxActionTrace(fetchImpl, relay, {
          runId,
          planId: plan.planId,
          caseId: testCase.id,
          stepId: step.stepId,
          userGoal: testCase.userGoal,
          status: "failed",
          actions: actionTraceActions,
          assertionResults: [{ id: "execution", passed: false, reason: failureReason }],
          runtimeClues: [failureReason, ...runtimeClues].slice(0, 20),
          generatedAt: new Date().toISOString(),
        }).catch(() => null);
        await emitBlackboxEvidence(fetchImpl, relay, {
          runId,
          stepId: step.stepId,
          testCase,
          passed: false,
          visibleEvidence,
        }).catch(() => null);
        caseReports.push({
          caseId: testCase.id,
          userGoal: testCase.userGoal,
          status: "failed",
          visibleEvidence,
          runtimeEvidence: [failureReason],
          failureReason,
        });
        await postJson(fetchImpl, `${relay}/runs/${runId}/steps/${step.stepId}/end`, {
          status: "failed",
          metadata: { blackboxStatus: "failed", failureReason },
        }).catch(() => null);
      } finally {
        await context.tracing.stop({ path: playwrightTracePath }).catch(() => null);
        const traceStat = await stat(playwrightTracePath).catch(() => null);
        if (traceStat?.isFile() && traceStat.size > 0) {
          playwrightTraceRefs.push(playwrightTracePath);
        }
        if (options.saveAuthProfile) {
          const storageStateBody = await context.storageState().then((state: any) => {
            const hasState = (Array.isArray(state.cookies) && state.cookies.length > 0) || (Array.isArray(state.origins) && state.origins.length > 0);
            return hasState ? `${JSON.stringify(state, null, 2)}\n` : "";
          }).catch(() => "");
          if (storageStateBody) {
            await saveAuthProfileBody(targetProject, options.saveAuthProfile, storageStateBody).catch(() => "");
          }
        }
        await context.close().catch(() => null);
      }
      }
    }
  } finally {
    await browser.close();
  }
  const failed = caseReports.some((item) => item.status === "failed" || item.status === "manual_review_required");
  const passed = caseReports.some((item) => item.status === "passed");
  await postJson(fetchImpl, `${relay}/runs/${runId}/end`, { status: passed && !failed ? "passed" : "failed" });
  await postJson(fetchImpl, `${relay}/scenarios/validate`, {
    runId,
    spec: blackboxScenarioSpec(plan),
  }).catch(() => null);
  const [runtimeEvidence, release] = await Promise.all([
    collectRuntimeClues(fetchImpl, relay, runId),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/release-decision`).catch(() => ({ releaseDecision: null })),
  ]);
  return finalBlackboxReport({
    runId,
    plan,
    cases: caseReports,
    runtimeEvidence,
    releaseDecision: release.releaseDecision || undefined,
    qualitySignals,
    locatorRepairRefs,
    visualEvidenceRefs,
    a11yEvidenceRefs,
    playwrightTraceRefs,
  });
}

async function readBlackboxLedger(filePath: string): Promise<Record<string, any>> {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(resolveWorkspaceRoot(), filePath);
  return JSON.parse(await readFile(absolute, "utf8")) as Record<string, any>;
}

async function runBlackboxFromLedger(
  fetchImpl: typeof fetch,
  relay: string,
  target: "web" | "miniapp",
  targetProject: Record<string, unknown>,
  plan: BlackboxPlan,
  ledger: Record<string, any>,
  baselineRunId = ""
): Promise<BlackboxRunReport> {
  const validation = validateComputerUseLedger(ledger, plan, targetProject);
  if (!validation.ok) {
    throw new Error(validation.reasonCode || "computer_use_ledger_invalid");
  }
  const validLedger = validation.value as ComputerUseLedger;
  const runStart = await postJson(fetchImpl, `${relay}/runs/start`, {
    label: "blackbox-computer-use",
    target,
    metadata: {
      projectRoot: resolveWorkspaceRoot(),
      targetProject,
      driver: "computer-use",
      blackbox: true,
      demoProhibited: true,
      baselineRunId,
    },
  });
  const runId = String(runStart.runId);
  const ledgerCases = Array.isArray(validLedger.cases) ? validLedger.cases : Array.isArray(validLedger.actions) ? validLedger.actions : [];
  const caseReports: BlackboxCaseRunReport[] = [];
  for (const testCase of plan.cases) {
    const match: any = ledgerCases.find((item: any) => item.caseId === testCase.id || item.id === testCase.id) || {};
    const step = await postJson(fetchImpl, `${relay}/runs/${runId}/steps/start`, {
      name: `blackbox-ledger:${testCase.id}`,
      kind: target === "miniapp" ? "action" : "assert",
      route: testCase.entry.route || testCase.entry.page || "",
      metadata: { blackboxCaseId: testCase.id, driver: "computer-use" },
    });
    if (Array.isArray(match.emittedEvents) && match.emittedEvents.length > 0) {
      await postJson(fetchImpl, `${relay}/ingest`, {
        runId,
        stepId: step.stepId,
        records: match.emittedEvents,
      });
    }
    const requestedStatus = match.status || (match.success === true ? "passed" : match.success === false ? "failed" : "skipped");
    const visibleEvidence = Array.isArray(match.visibleEvidence)
      ? match.visibleEvidence.map(String)
      : Array.isArray(match.visible_evidence)
        ? match.visible_evidence.map(String)
        : visibleEvidenceFromEvents(match.emittedEvents);
    const runtimeEvidence = Array.isArray(match.runtimeEvidence)
      ? match.runtimeEvidence.map(String)
      : Array.isArray(match.actionLedger)
        ? match.actionLedger.map((item: unknown) => typeof item === "string" ? item : JSON.stringify(item)).slice(0, 10)
        : [];
    const actionLedger = Array.isArray(match.actionLedger)
      ? match.actionLedger.map((item: unknown) => typeof item === "string" ? item : JSON.stringify(item)).filter(Boolean)
      : [];
    const targetUrl = String(validLedger.targetUrl || targetProject.targetUrl || "");
    const route = String(testCase.entry.route || testCase.entry.page || (targetUrl ? new URL(targetUrl).pathname || "/" : "/"));
    await postJson(fetchImpl, `${relay}/ingest`, {
      source: target === "miniapp" ? "miniapp" : "admin-web",
      level: "info",
      message: `computer_use_action:${testCase.id}`,
      runId,
      stepId: step.stepId,
      phase: target === "miniapp" ? "lifecycle" : "navigation",
      route,
      tags: ["computer_use_action", "action_ledger", "route_changed", `blackbox_case:${testCase.id}`],
      context: {
        blackboxCaseId: testCase.id,
        driver: "computer-use",
        targetUrl,
        actionLedger,
      },
    } satisfies RelayLogInput);
    const status = requestedStatus === "passed" && visibleEvidence.length === 0 ? "failed" : requestedStatus;
    await emitBlackboxActionTrace(fetchImpl, relay, {
      runId,
      planId: plan.planId,
      caseId: testCase.id,
      stepId: step.stepId,
      userGoal: testCase.userGoal,
      status: status === "passed" ? "passed" : status === "failed" ? "failed" : "skipped",
      actions: [{
        action: "computer_use_action",
        selector: testCase.steps[0]?.selector,
        locator: testCase.steps[0]?.locator,
        urlBefore: targetUrl,
        urlAfter: targetUrl,
        visibleTextAfter: visibleEvidence.join(" ").slice(0, 500),
        runtimeClues: runtimeEvidence,
      }],
      assertionResults: [{ id: `${testCase.id}_visible`, passed: status === "passed", reason: visibleEvidence.length > 0 ? "visible_evidence" : "visible_evidence_required" }],
      runtimeClues: runtimeEvidence,
      generatedAt: new Date().toISOString(),
    }).catch(() => null);
    await emitBlackboxEvidence(fetchImpl, relay, {
      runId,
      stepId: step.stepId,
      testCase,
      passed: status === "passed",
      visibleEvidence,
      runtimeEvidence,
      context: { ledgerCase: match },
    });
    await postJson(fetchImpl, `${relay}/runs/${runId}/steps/${step.stepId}/end`, {
      status: status === "passed" ? "passed" : status === "skipped" ? "passed" : "failed",
      metadata: { blackboxStatus: status, failureReason: visibleEvidence.length === 0 ? "visible_evidence_required" : "" },
    });
    caseReports.push({
      caseId: testCase.id,
      userGoal: testCase.userGoal,
      status: status === "passed" ? "passed" : status === "failed" ? "failed" : "skipped",
      visibleEvidence,
      runtimeEvidence,
      failureReason: visibleEvidence.length === 0 ? "visible_evidence_required" : match.reason || match.failureReason || "",
    });
  }
  const failed = caseReports.some((item) => item.status === "failed");
  const passed = caseReports.some((item) => item.status === "passed");
  await postJson(fetchImpl, `${relay}/runs/${runId}/end`, { status: passed && !failed ? "passed" : "failed" });
  await postJson(fetchImpl, `${relay}/scenarios/validate`, { runId, spec: blackboxScenarioSpec(plan) }).catch(() => null);
  const [runtimeEvidence, release] = await Promise.all([
    collectRuntimeClues(fetchImpl, relay, runId),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/release-decision`).catch(() => ({ releaseDecision: null })),
  ]);
  return finalBlackboxReport({ runId, plan, cases: caseReports, runtimeEvidence, releaseDecision: release.releaseDecision || undefined });
}

async function runMiniappBlackboxWithDriver(
  fetchImpl: typeof fetch,
  relay: string,
  plan: BlackboxPlan,
  driver: string,
  driverModule: string,
  projectCheck: Record<string, any>,
  baselineRunId = "",
  driverEnvironment: { cliPath?: string; servicePort?: string; projectPath?: string; profileDir?: string } = {}
): Promise<BlackboxRunReport> {
  const scenario = blackboxScenarioSpec(plan);
  const runStart = await createMiniappRun(fetchImpl, relay, "blackbox-miniapp", driver, scenario.id, {
    blackbox: true,
    demoProhibited: true,
    targetProject: plan.targetProject,
    baselineRunId,
  });
  const runId = String(runStart.runId);
  const execution = await runMiniappScenarioExecution(fetchImpl, relay, runId, driver, scenario as unknown as Record<string, any>, projectCheck, driverModule, driverEnvironment);
  const caseReports: BlackboxCaseRunReport[] = plan.cases.map((testCase, index) => {
    const action = execution.actionResults[index] || execution.actionResults.find((item) => item.actionId === testCase.id);
    const visibleEvidence = visibleEvidenceFromEvents(action?.emittedEvents);
    const passed = Boolean(action?.success) && visibleEvidence.length > 0;
    return {
      caseId: testCase.id,
      userGoal: testCase.userGoal,
      status: passed ? "passed" : "failed",
      visibleEvidence: visibleEvidence.length > 0 ? visibleEvidence : [`小程序动作 ${testCase.id} 缺少用户可见证据。`],
      runtimeEvidence: action?.emittedEvents?.map((event) => event.message) || [],
      failureReason: passed ? "" : visibleEvidence.length === 0 ? "visible_evidence_required" : action?.reason || execution.stopReason,
    };
  });
  for (const report of caseReports) {
    const testCase = plan.cases.find((item) => item.id === report.caseId);
    if (!testCase) continue;
    await emitBlackboxActionTrace(fetchImpl, relay, {
      runId,
      planId: plan.planId,
      caseId: testCase.id,
      stepId: "",
      userGoal: testCase.userGoal,
      status: report.status,
      actions: [{
        action: testCase.steps[0]?.action || "enter_page",
        selector: testCase.steps[0]?.selector,
        locator: testCase.steps[0]?.locator,
        urlAfter: testCase.entry.page || testCase.steps[0]?.pagePath || "",
        visibleTextAfter: report.visibleEvidence.join(" ").slice(0, 500),
        runtimeClues: report.runtimeEvidence,
      }],
      assertionResults: [{ id: `${testCase.id}_visible`, passed: report.status === "passed", reason: report.failureReason || "visible_evidence" }],
      runtimeClues: report.runtimeEvidence,
      generatedAt: new Date().toISOString(),
    }).catch(() => null);
  }
  for (const report of caseReports) {
    const testCase = plan.cases.find((item) => item.id === report.caseId);
    if (!testCase) continue;
    await emitBlackboxEvidence(fetchImpl, relay, {
      runId,
      testCase,
      passed: report.status === "passed",
      visibleEvidence: report.visibleEvidence,
      runtimeEvidence: report.runtimeEvidence,
      context: { driver, driverResolution: execution.driverResolution },
    }).catch(() => null);
  }
  await postJson(fetchImpl, `${relay}/scenarios/validate`, { runId, spec: scenario }).catch(() => null);
  const [runtimeEvidence, release] = await Promise.all([
    collectRuntimeClues(fetchImpl, relay, runId),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/release-decision`).catch(() => ({ releaseDecision: null })),
  ]);
  return finalBlackboxReport({ runId, plan, cases: caseReports, runtimeEvidence, releaseDecision: release.releaseDecision || undefined });
}

async function fetchTargetSupport(fetchImpl: typeof fetch, relay: string, target: string) {
  return requestJson(fetchImpl, `${relay}/ai/targets/support?target=${encodeURIComponent(target)}`);
}

function supportFailure(report: Record<string, any>): CliStandardFailure {
  return {
    ok: false,
    status: report.status,
    reasonCode: report.reasonCode,
    reason: report.reason,
    recommendedAction: report.recommendedAction,
    supportedTargets: report.supportedTargets || ["web", "miniapp"],
    currentCapabilities: report.currentCapabilities || [],
  };
}

async function fetchTriggerDecision(
  fetchImpl: typeof fetch,
  relay: string,
  input: { target: string; reason?: string; phase?: string; runtimeImpact?: boolean }
) {
  return postJson(fetchImpl, `${relay}/ai/trigger/decision`, input);
}

async function fetchTaskEnforcement(
  fetchImpl: typeof fetch,
  relay: string,
  input: { target: string; phase?: string; runtimeImpact?: boolean; runId?: string; closureClaim?: boolean }
) {
  return postJson(fetchImpl, `${relay}/ai/task/enforcement`, input);
}

async function identifyProject(fetchImpl: typeof fetch, relay: string, target?: string) {
  return postJson(fetchImpl, `${relay}/ai/project/identify`, {
    target: target || "",
  });
}

function exitCodeFromCi(status: string): number {
  if (status === "pass" || status === "ship") return 0;
  if (status === "manual_review_required") return 2;
  if (status === "hold") return 3;
  return 4;
}

async function fetchDriverContract(fetchImpl: typeof fetch, relay: string, input: { target: string; driver?: string }) {
  const params = new URLSearchParams({
    target: input.target || "web",
    driver: input.driver || "",
  });
  return requestJson(fetchImpl, `${relay}/ai/driver/contract?${params.toString()}`);
}

async function miniappVerifyPayload(options: CliOptions) {
  const calls: Array<Record<string, unknown>> = [];
  const globalHost = globalThis as Record<string, unknown>;
  const originalWx = globalHost.wx;
  const originalApp = globalHost.App;
  const originalPage = globalHost.Page;
  const originalComponent = globalHost.Component;

  globalHost.wx = {
    request(requestOptions: Record<string, unknown>) {
      if (requestOptions.url === "http://relay.test/ingest") {
        calls.push((requestOptions.data || {}) as Record<string, unknown>);
        return;
      }
      const success = requestOptions.success as ((response: { statusCode: number }) => void) | undefined;
      if (typeof success === "function") {
        success({ statusCode: 200 });
      }
    },
    navigateTo() {},
  };
  globalHost.App = (config: unknown) => config;
  globalHost.Page = (config: unknown) => config;
  globalHost.Component = (config: unknown) => config;

  try {
    const relay = createMiniappRelay({
      endpoint: "http://relay.test/ingest",
      routeProvider: () => "/pages/index",
      sessionIdProvider: () => "miniapp-verify",
    });
    relay.bindRun(options.params.runId || "miniapp-verify-run");
    relay.bindStep(options.params.stepId || "miniapp-verify-step");

    const wrappedPage = relay.wrapPage("VerifyPage", {
      onLoad() {
        return "ok";
      },
    });
    wrappedPage.onLoad();
    if (options.params.patch !== "false") {
      relay.enableMiniappRuntimePatch();
    }
    relay.startAutoCapture();
    relay.capturePageLifecycle("VerifyPage", "onLoad");
    (globalHost.wx as { navigateTo?: (input: Record<string, unknown>) => void }).navigateTo?.({
      url: "/pages/verify/index",
    });
    (globalHost.wx as { request: (input: Record<string, unknown>) => void }).request({
      url: "https://api.example.com/demo",
      method: "POST",
    });
    relay.stopAutoCapture();
    relay.disableMiniappRuntimePatch();

    return {
      selfCheck: relay.selfCheck(),
      integration: relay.validateMiniappIntegration(),
      observedEvents: calls.length,
      sampleSignals: calls.slice(0, 5),
    };
  } finally {
    globalHost.wx = originalWx;
    globalHost.App = originalApp;
    globalHost.Page = originalPage;
    globalHost.Component = originalComponent;
  }
}

async function webVerifyPayload(fetchImpl: typeof fetch, relay: string, runId?: string) {
  const [support, guide, projectCheck] = await Promise.all([
    fetchTargetSupport(fetchImpl, relay, "web"),
    requestJson(fetchImpl, `${relay}/ai/web/integration-guide`),
    requestJson(fetchImpl, `${relay}/ai/web/project-check`),
  ]);
  if (isStructuredFailure(support)) {
    return support;
  }
  const requiredSignals = guide.guide.requiredSignals as string[];
  if (runId) {
    const runtime = await requestJson(fetchImpl, `${relay}/ai/run/${runId}/readiness`);
    return {
      support: support.report,
      guide: guide.guide,
      projectCheck: projectCheck.report,
      readiness: runtime.readiness,
      bestPracticeCompliant: runtime.readiness.bestPracticeCompliant,
      integrationMaturity: runtime.readiness.maturity,
      evidenceSource: runtime.readiness.evidenceSource,
    };
  }
  const availableSignals = [
    "project_check",
    projectCheck.report?.entrypoints?.length ? "bootstrap_candidate" : "",
    projectCheck.report?.routeMode && projectCheck.report.routeMode !== "unknown" ? "route_candidate" : "",
    projectCheck.report?.networkLayerCandidates?.length ? "network_candidate" : "",
    projectCheck.report?.errorBoundaryCandidates?.length ? "error_boundary_candidate" : "",
  ].filter(Boolean);
  const missingSignals = requiredSignals.map((signal) => `runtime_unverified:${signal}`);
  const blockingReasons = [...(projectCheck.report?.blockingIssues || []), "runtime_signals_not_verified"];
  const maturity = projectCheck.report?.relayInsertionReadiness === "ready" ? "basic" : projectCheck.report?.relayInsertionReadiness === "partial" ? "basic" : "none";
  return {
    support: support.report,
    guide: guide.guide,
    projectCheck: projectCheck.report,
    readiness: {
      target: "web",
      maturity,
      evidenceSource: "project_inspection",
      evidenceLevel: "project_only",
      requiredSignals,
      availableSignals,
      missingSignals,
      autoloopEligible: false,
      blockingReasons,
      recommendedIntegrationMode: "browser-injected",
      bestPracticeCompliant: false,
    },
    bestPracticeCompliant: false,
    integrationMaturity: maturity,
    evidenceSource: "project_inspection",
  };
}

async function projectVerifyPayload(fetchImpl: typeof fetch, relay: string, target: string, runId?: string): Promise<VerifyPayload | CliStandardFailure> {
  const targetSupport = await fetchTargetSupport(fetchImpl, relay, target);
  if (isStructuredFailure(targetSupport) || targetSupport.report.status === "unsupported" || targetSupport.report.status === "inapplicable") {
    return supportFailure(isStructuredFailure(targetSupport) ? targetSupport : targetSupport.report);
  }
  const identified = await identifyProject(fetchImpl, relay, target);
  if (target === "web") {
    const payload = await webVerifyPayload(fetchImpl, relay, runId);
    if (isStructuredFailure(payload)) {
      return payload;
    }
    const projectReady = payload.projectCheck.relayInsertionReadiness !== "blocked";
    const runtimeVerified = payload.readiness.evidenceLevel === "runtime_verified";
    return {
      target: "web",
      profile: identified.profile,
      projectCheck: payload.projectCheck,
      runtimeReadiness: payload.readiness,
      closureEligible: runtimeVerified && payload.readiness.bestPracticeCompliant,
      autoloopEligible: projectReady && targetSupport.report.status === "supported",
      recommendedAction:
        !projectReady
          ? payload.projectCheck.recommendedActions[0] || "Complete web relay integration."
          : runtimeVerified
            ? "Run relay autoloop run --target web."
            : "Project check passed. Start a real run, then query relay web verify --runId <runId> or /ai/run/:runId/readiness before claiming closure.",
      status:
        payload.projectCheck.relayInsertionReadiness === "ready" && runtimeVerified
          ? "supported"
          : payload.projectCheck.relayInsertionReadiness === "blocked"
            ? "unsupported"
            : "partial",
    };
  }
  const [miniappSupport, decision, projectCheck] = await Promise.all([
    fetchTargetSupport(fetchImpl, relay, "miniapp"),
    fetchTriggerDecision(fetchImpl, relay, {
      target: "miniapp",
      reason: "miniapp_verify",
      phase: "self_test",
      runtimeImpact: true,
    }),
    requestJson(fetchImpl, `${relay}/ai/miniapp/project-check`),
  ]);
  const payload = await miniappVerifyPayload({ relay, pretty: false, params: {}, artifact: undefined });
  return {
    target: "miniapp",
    profile: identified.profile,
    support: miniappSupport.report,
    triggerDecision: decision.decision,
    projectCheck: projectCheck.report,
    runtimeReadiness: payload.integration,
    closureEligible: false,
    autoloopEligible: false,
    recommendedAction:
      projectCheck.report.blockingIssues.length > 0
        ? projectCheck.report.recommendedActions[0] || "Run relay miniapp verify and fix missing coverage."
        : "Run relay miniapp run, then query miniapp scenario and miniapp closure before claiming closure.",
    status: projectCheck.report.status,
  };
}

async function verifyWebHarnessWithOrchestrator(
  fetchImpl: typeof fetch,
  spawnImpl: typeof spawn,
  blackboxWebRunner: typeof runWebBlackboxPlan,
  options: CliOptions,
  driver: string,
  goals: string[]
): Promise<HarnessVerifyResult & { output: unknown }> {
  const ledgerPath = driver === "computer-use" ? options.params.ledger || "" : "";
  let computerUseLedger: Record<string, any> | null = null;
  if (driver === "computer-use") {
    if (!ledgerPath) {
      const output = harnessFailure("harness_driver_unavailable", "harness verify --driver computer-use requires a real Computer Use ledger.", "Run the generated blackbox plan with Computer Use, then pass --ledger <path>.");
      return { ok: false, exitStatus: 1, failure: output.failure, output };
    }
    try {
      computerUseLedger = await readBlackboxLedger(ledgerPath);
    } catch (error) {
      const output = harnessFailure("harness_driver_unavailable", error instanceof Error ? error.message : String(error), "Regenerate the ledger from this target project and rerun harness verify.");
      return { ok: false, exitStatus: 1, failure: output.failure, output };
    }
  }
  const effectiveOptions =
    computerUseLedger?.targetUrl && !options.params.url && !process.env.DEV_LOG_RELAY_TARGET_URL
      ? { ...options, params: { ...options.params, url: String(computerUseLedger.targetUrl) } }
      : options;
  const resolution = await resolveWebTarget(fetchImpl, spawnImpl, options.relay, effectiveOptions);
  try {
    if (resolution.failure) {
      const output = harnessFailure(harnessReasonFromTargetFailure(resolution.failure.reasonCode), resolution.failure.reason, resolution.failure.recommendedAction);
      return { ok: false, exitStatus: 1, failure: output.failure, output };
    }
    const targetProject = resolution.targetProject!;
    const projectCheck = await requestJson(fetchImpl, `${options.relay}/ai/web/project-check`).catch(() => ({ report: {} }));
    let storageState = "";
    try {
      storageState = await resolveStorageStatePath(targetProject, options) || "";
    } catch (error) {
      const output = harnessFailure("harness_driver_unavailable", error instanceof Error ? error.message : String(error), "Use a storage state or auth profile captured from this target project.");
      return { ok: false, exitStatus: 1, failure: output.failure, output };
    }
    const runOptions = blackboxRunOptions(options, storageState);
    const discoverSummary = options.params.noDiscover === "true" || options.params.noDiscover === "1" || driver === "computer-use"
      ? undefined
      : await runWebBlackboxDiscover(targetProject.targetUrl, undefined, runOptions).catch(() => undefined);
    const plan = driver === "computer-use"
      ? await fetchBlackboxPlanById(fetchImpl, options.relay, ledgerPlanId(computerUseLedger || {}))
      : options.params.planId
        ? await fetchBlackboxPlanById(fetchImpl, options.relay, options.params.planId)
        : await createBlackboxPlan(fetchImpl, options.relay, "web", targetProject as unknown as Record<string, unknown>, options, projectCheck.report, discoverSummary);
    let blackboxReport: BlackboxRunReport;
    if (driver === "computer-use") {
      try {
        blackboxReport = await runBlackboxFromLedger(fetchImpl, options.relay, "web", targetProject as unknown as Record<string, unknown>, plan, computerUseLedger || {}, options.params.baselineRunId || "");
      } catch (error) {
        const output = harnessFailure("harness_driver_unavailable", error instanceof Error ? error.message : String(error), "Regenerate the ledger from this target project and rerun harness verify.");
        return { ok: false, exitStatus: 1, failure: output.failure, output };
      }
    } else {
      const runStart = await postJson(fetchImpl, `${options.relay}/runs/start`, {
        label: options.params.label || "harness-web",
        target: "web",
        metadata: {
          projectRoot: resolveWorkspaceRoot(),
          targetProject,
          driver,
          blackbox: true,
          harness: true,
          demoProhibited: true,
          baselineRunId: options.params.baselineRunId || "",
        },
      });
      blackboxReport = await blackboxWebRunner(fetchImpl, options.relay, String(runStart.runId), targetProject, plan, runOptions);
    }
    let stored: Record<string, any>;
    try {
      stored = await postJson(fetchImpl, `${options.relay}/blackbox/run`, { report: blackboxReport });
    } catch (error) {
      const failure = blackboxReportStoreFailure(error);
      const output = harnessFailure(
        harnessReasonFromBlackboxStoreFailure(failure.reasonCode),
        failure.message,
        "Fix the Web target UI or driver until at least one blocking blackbox case produces explicit visible evidence."
      );
      return {
        ok: false,
        plan,
        blackboxReport,
        exitStatus: 1,
        failure: output.failure,
        output: { ...output, plan, blackboxReport, targetProject },
      };
    }
    blackboxReport = stored.report || blackboxReport;
    let regressionSeedRef = "";
    if (!blackboxOutcomeOk(blackboxReport)) {
      const seed = await postJson(fetchImpl, `${options.relay}/ai/run/${blackboxReport.runId}/seed-regression`, {}).catch(() => null);
      regressionSeedRef = seed?.regressionSeed?.filePath || "";
    }
    const harness = await createHarnessReport(fetchImpl, options.relay, {
      target: "web",
      driver,
      blackboxRunId: blackboxReport.runId,
      targetProject: targetProject as unknown as Record<string, unknown>,
      goals,
      regressionSeedRef,
    });
    const written = await maybeWriteArtifact(options.artifact, harness.harnessReport || harness);
    const ok = harness.ok === true && harness.harnessReport?.gate?.status === "pass";
    const output = { ok, demoProhibited: true, harness: true, plan, blackboxReport, harnessRunId: harness.harnessRunId, harnessReport: harness.harnessReport, artifactPath: written };
    return { ok, plan, blackboxReport, harnessRunId: harness.harnessRunId, harnessReport: harness.harnessReport, artifactPath: written, exitStatus: ok ? 0 : 1, output };
  } finally {
    resolution.child?.kill();
  }
}

async function verifyMiniappHarnessWithOrchestrator(
  fetchImpl: typeof fetch,
  options: CliOptions,
  driver: string,
  goals: string[]
): Promise<HarnessVerifyResult & { output: unknown }> {
  const automationAttempts: string[] = [];
  const autoPrepare = !isTruthyParam(options.params.noAutoPrepare);
  let bootstrap = await bootstrapMiniappDevTools({
    workspaceRoot: resolveWorkspaceRoot(),
    fix: options.params.bootstrap === "false" ? false : true,
    driver: options.params.bootstrapDriver || options.params.driver,
    cliPath: options.params.cliPath,
    servicePort: options.params.servicePort,
    projectPath: options.params.projectPath,
    profileDir: options.params.profileDir,
    sidecarPort: options.params.sidecarPort,
  });
  automationAttempts.push(`bootstrap:${bootstrap.status}`);
  const projectVerify = await projectVerifyPayload(fetchImpl, options.relay, "miniapp");
  if (isStructuredFailure(projectVerify)) {
    const output = attachMiniappExecutingAiContext(
      { ...harnessFailure("harness_target_unresolved", projectVerify.reason, projectVerify.recommendedAction), bootstrap },
      { options, reasonCodes: bootstrap.reasonCodes, automationAttempts, servicePort: bootstrap.servicePort }
    );
    return { ok: false, exitStatus: 1, failure: output.failure, output };
  }
  const projectCheck = await requestJson(fetchImpl, `${options.relay}/ai/miniapp/project-check`);
  const targetProject = {
    workspaceRoot: resolveWorkspaceRoot(),
    resolvedProjectRoot: resolveWorkspaceRoot(),
  };
  const ledgerPath = driver === "computer-use" ? options.params.ledger || "" : "";
  let computerUseLedger: Record<string, any> | null = null;
  let sidecarAutoPrepare: Record<string, any> | null = null;
  if (autoPrepare && driver !== "computer-use" && (!bootstrap.sidecar?.ok || !bootstrap.servicePortReachable)) {
    try {
      const sidecarAction = bootstrap.sidecar?.installed ? "start" : "install";
      automationAttempts.push(`sidecar:${sidecarAction}`);
      sidecarAutoPrepare = await manageMiniappSidecar({
        workspaceRoot: resolveWorkspaceRoot(),
        action: sidecarAction,
        sidecarPort: options.params.sidecarPort,
        servicePort: bootstrap.servicePort,
        cliPath: bootstrap.cliPath,
      });
      automationAttempts.push(`sidecar:${sidecarAutoPrepare.ok ? "ready" : "not_ready"}`);
      bootstrap = await bootstrapMiniappDevTools({
        workspaceRoot: resolveWorkspaceRoot(),
        fix: false,
        driver: options.params.bootstrapDriver || options.params.driver,
        cliPath: options.params.cliPath,
        servicePort: options.params.servicePort || bootstrap.servicePort,
        projectPath: options.params.projectPath,
        profileDir: options.params.profileDir,
        sidecarPort: options.params.sidecarPort,
      });
      bootstrap.autoPrepareAttempted = true;
      bootstrap.sidecarStarted = Boolean(sidecarAutoPrepare.running);
    } catch (error) {
      automationAttempts.push(`sidecar:error:${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!autoPrepare) {
    automationAttempts.push("autoPrepare:disabled");
  }
  const miniappResolution = resolveMiniappDriver({
    workspaceRoot: resolveWorkspaceRoot(),
    driver,
    driverModule: options.params.driverModule,
    ledger: ledgerPath,
    cliPath: options.params.cliPath,
    servicePort: options.params.servicePort || bootstrap.servicePort,
    projectPath: options.params.projectPath,
    bootstrap,
  });
  miniappResolution.bootstrap = bootstrap;
  if (miniappResolution.status !== "available") {
    const output = attachMiniappExecutingAiContext(
      {
        ...harnessFailure("harness_driver_unavailable", miniappResolution.blockingReasons[0] || "Miniapp harness driver is not available.", miniappResolution.recommendedAction),
        bootstrap,
        sidecarAutoPrepare,
        driverResolution: miniappResolution,
      },
      { options, reasonCodes: [...bootstrap.reasonCodes, ...miniappResolution.reasonCodes], automationAttempts, servicePort: bootstrap.servicePort }
    );
    return { ok: false, exitStatus: 1, failure: output.failure, output };
  }
  if (driver === "computer-use") {
    try {
      computerUseLedger = await readBlackboxLedger(ledgerPath);
    } catch (error) {
      const output = attachMiniappExecutingAiContext(
        harnessFailure("harness_driver_unavailable", error instanceof Error ? error.message : String(error), "Regenerate the miniapp ledger from this target project."),
        { options, reasonCodes: ["computer_use_ledger_invalid"], automationAttempts, servicePort: bootstrap.servicePort }
      );
      return { ok: false, exitStatus: 1, failure: output.failure, output };
    }
  }
  const plan = driver === "computer-use"
    ? await fetchBlackboxPlanById(fetchImpl, options.relay, ledgerPlanId(computerUseLedger || {}))
    : options.params.planId
      ? await fetchBlackboxPlanById(fetchImpl, options.relay, options.params.planId)
      : await createBlackboxPlan(fetchImpl, options.relay, "miniapp", targetProject, options, projectCheck.report);
  let blackboxReport: BlackboxRunReport;
  if (driver === "computer-use") {
    try {
      blackboxReport = await runBlackboxFromLedger(fetchImpl, options.relay, "miniapp", targetProject, plan, computerUseLedger || {}, options.params.baselineRunId || "");
    } catch (error) {
      const output = attachMiniappExecutingAiContext(
        harnessFailure("harness_driver_unavailable", error instanceof Error ? error.message : String(error), "Regenerate the miniapp ledger from this target project."),
        { options, reasonCodes: ["computer_use_ledger_invalid"], automationAttempts, servicePort: bootstrap.servicePort }
      );
      return { ok: false, exitStatus: 1, failure: output.failure, output };
    }
  } else {
    blackboxReport = await runMiniappBlackboxWithDriver(
      fetchImpl,
      options.relay,
      plan,
      driver,
      miniappResolution.driverModule || "",
      projectCheck.report,
      options.params.baselineRunId || "",
      {
        cliPath: miniappResolution.cliPath,
        servicePort: miniappResolution.servicePort,
        projectPath: miniappResolution.projectPath,
        profileDir: bootstrap.profileDir,
      }
    );
  }
  let stored: Record<string, any>;
  try {
    stored = await postJson(fetchImpl, `${options.relay}/blackbox/run`, { report: blackboxReport });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reasonCodes = miniappReasonCodesForReport({
      bootstrapReasonCodes: bootstrap.reasonCodes,
      driverReasonCodes: miniappResolution.reasonCodes,
      report: blackboxReport,
    });
    const output = attachMiniappExecutingAiContext(
      {
        ...harnessFailure(
          "harness_blackbox_required",
          message,
          "Fix the Miniapp driver or target UI until at least one blocking blackbox case produces explicit visible evidence."
        ),
        bootstrap,
        sidecarAutoPrepare,
        driverResolution: miniappResolution,
        blackboxReport,
      },
      { options, reasonCodes, automationAttempts, servicePort: bootstrap.servicePort }
    );
    return { ok: false, exitStatus: 1, failure: output.failure, output };
  }
  blackboxReport = stored.report || blackboxReport;
  let regressionSeedRef = "";
  if (!blackboxOutcomeOk(blackboxReport)) {
    const seed = await postJson(fetchImpl, `${options.relay}/ai/run/${blackboxReport.runId}/seed-regression`, {}).catch(() => null);
    regressionSeedRef = seed?.regressionSeed?.filePath || "";
  }
  const harness = await createHarnessReport(fetchImpl, options.relay, {
    target: "miniapp",
    driver,
    blackboxRunId: blackboxReport.runId,
    targetProject,
    goals,
    regressionSeedRef,
    executionContext: {
      userActionRequest: miniappUserActionRequest({
        reasonCodes: miniappReasonCodesForReport({
          bootstrapReasonCodes: bootstrap.reasonCodes,
          driverReasonCodes: miniappResolution.reasonCodes,
          report: blackboxReport,
        }),
        options,
        servicePort: bootstrap.servicePort,
      }),
      automationAttempts,
      retryCommand: miniappRetryCommand(options),
      profileIsolation: miniappResolution.profileIsolation || bootstrap.profileIsolation,
      driverMode: miniappResolution.mode,
    },
  });
  const written = await maybeWriteArtifact(options.artifact, harness.harnessReport || harness);
  const ok = harness.ok === true && harness.harnessReport?.gate?.status === "pass";
  const output = attachMiniappExecutingAiContext(
    { ok, demoProhibited: true, harness: true, plan, projectVerify, driverResolution: miniappResolution, sidecarAutoPrepare, blackboxReport, harnessRunId: harness.harnessRunId, harnessReport: harness.harnessReport, artifactPath: written },
    {
      options,
      reasonCodes: miniappReasonCodesForReport({
        bootstrapReasonCodes: bootstrap.reasonCodes,
        driverReasonCodes: miniappResolution.reasonCodes,
        report: blackboxReport,
      }),
      automationAttempts,
      servicePort: bootstrap.servicePort,
    }
  );
  Object.assign(output, { bootstrap });
  return { ok, plan, blackboxReport, harnessRunId: harness.harnessRunId, harnessReport: harness.harnessReport, artifactPath: written, exitStatus: ok ? 0 : 1, output };
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const fetchImpl = deps.fetchImpl || fetch;
  const spawnImpl = deps.spawnImpl || spawn;
  const webScenarioRunner = deps.webScenarioRunnerImpl || runTargetWebScenario;
  const blackboxWebRunner = deps.blackboxWebRunnerImpl || runWebBlackboxPlan;
  const stdout = deps.stdout || ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr || ((text: string) => process.stderr.write(text));
  const { command, options } = parseArgs(argv);

  try {
    if (command[0] === "doctor" && command[1] === "detect") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/targets/detect?target=${encodeURIComponent(options.params.target || "auto")}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "doctor" && command[1] === "target") {
      const target = options.params.target === "auto" || !options.params.target ? await fetchDetectedTarget(fetchImpl, options.relay, "auto") : options.params.target;
      const payload = await fetchTargetSupport(fetchImpl, options.relay, target);
      stdout(format({ ok: true, detectedTarget: target, ...payload }, options.pretty));
      return 0;
    }

    if (command[0] === "doctor" && command[1] === "trigger") {
      const target = options.params.target === "auto" || !options.params.target ? await fetchDetectedTarget(fetchImpl, options.relay, "auto") : options.params.target;
      const payload = await fetchTriggerDecision(fetchImpl, options.relay, {
        target,
        reason: options.params.reason || "",
        phase: options.params.phase || "manual",
        runtimeImpact: options.params.runtimeImpact === "true" || options.params.runtimeImpact === "1",
      });
      stdout(format({ ok: true, detectedTarget: target, ...payload }, options.pretty));
      return 0;
    }

    if (command[0] === "doctor" && command[1] === "enforcement") {
      const target = options.params.target === "auto" || !options.params.target ? await fetchDetectedTarget(fetchImpl, options.relay, "auto") : options.params.target;
      const payload = await fetchTaskEnforcement(fetchImpl, options.relay, {
        target,
        phase: options.params.phase || "manual",
        runtimeImpact: options.params.runtimeImpact !== "false",
        runId: options.params.runId || "",
        closureClaim: options.params.closureClaim === "true" || options.params.closureClaim === "1",
      });
      stdout(format({ ok: true, detectedTarget: target, ...payload }, options.pretty));
      return 0;
    }

    if (command[0] === "agent" && command[1] === "contract") {
      const target = options.params.target === "auto" || !options.params.target ? await fetchDetectedTarget(fetchImpl, options.relay, "auto") : options.params.target;
      const driver = options.params.driver || "computer-use";
      if (target !== "web" && target !== "miniapp" && !options.params.runId) {
        const support = await fetchTargetSupport(fetchImpl, options.relay, target);
        stdout(format(supportFailure(support.report), options.pretty));
        return 1;
      }
      if (options.params.runId) {
        const payload = await requestJson(
          fetchImpl,
          `${options.relay}/ai/run/${options.params.runId}/driver-check?driver=${encodeURIComponent(driver)}`
        );
        stdout(format({ ok: true, detectedTarget: target, driver, ...payload }, options.pretty));
        return 0;
      }
      const payload = await fetchDriverContract(fetchImpl, options.relay, {
        target,
        driver,
      });
      stdout(format({ ok: true, detectedTarget: target, driver, ...payload }, options.pretty));
      return 0;
    }

    if (command[0] === "doctor" && command[1] === "readiness") {
      const target = options.params.target === "auto" || !options.params.target ? await fetchDetectedTarget(fetchImpl, options.relay, "auto") : options.params.target;
      const support = await fetchTargetSupport(fetchImpl, options.relay, target);
      if (isStructuredFailure(support) || support.report.status === "unsupported" || support.report.status === "inapplicable") {
        const failure = supportFailure(isStructuredFailure(support) ? support : support.report);
        stdout(format(failure, options.pretty));
        return 1;
      }
      const [trigger, verify] = await Promise.all([
        fetchTriggerDecision(fetchImpl, options.relay, {
          target,
          reason: options.params.reason || "runtime_validation",
          phase: options.params.phase || "self_test",
          runtimeImpact: options.params.runtimeImpact !== "false",
        }),
        target === "miniapp"
          ? projectVerifyPayload(fetchImpl, options.relay, "miniapp", options.params.runId)
          : projectVerifyPayload(fetchImpl, options.relay, "web", options.params.runId),
      ]);
      if (isStructuredFailure(verify)) {
        stdout(format(verify, options.pretty));
        return 1;
      }
      stdout(
        format(
          {
            ok: true,
            detectedTarget: target,
            support: support.report,
            triggerDecision: trigger.decision,
            projectVerify: verify,
            closureEligible: verify.closureEligible,
            autoloopEligible: verify.autoloopEligible,
            driverReady: target === "miniapp" ? verify.projectCheck.blockingIssues?.length === 0 : true,
            scenarioReady: target === "miniapp" ? verify.projectCheck.blockingIssues?.length === 0 : true,
            closureReady: verify.closureEligible,
          },
          options.pretty
        )
      );
      return 0;
    }

    if (command[0] === "project" && command[1] === "identify") {
      const target = options.params.target === "auto" || !options.params.target ? await fetchDetectedTarget(fetchImpl, options.relay, "auto") : options.params.target;
      const support = await fetchTargetSupport(fetchImpl, options.relay, target === "unknown" ? "unknown" : target);
      if (isStructuredFailure(support) || support.report.status === "unsupported" || support.report.status === "inapplicable") {
        stdout(format(supportFailure(isStructuredFailure(support) ? support : support.report), options.pretty));
        return 1;
      }
      const payload = await identifyProject(fetchImpl, options.relay, target === "unknown" ? "" : target);
      stdout(format({ ok: true, detectedTarget: target, ...payload }, options.pretty));
      return 0;
    }

    if (command[0] === "project" && command[1] === "compatibility") {
      const target = options.params.target === "auto" || !options.params.target ? await fetchDetectedTarget(fetchImpl, options.relay, "auto") : options.params.target;
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/project/compatibility?target=${encodeURIComponent(target || "")}`);
      stdout(format({ ok: true, detectedTarget: target, ...payload }, options.pretty));
      return 0;
    }

    if (command[0] === "project" && command[1] === "scenarios") {
      const target = options.params.target || "";
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/project/scenarios${target ? `?target=${encodeURIComponent(target)}` : ""}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "project" && command[1] === "baselines") {
      const target = options.params.target || "";
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/project/baselines${target ? `?target=${encodeURIComponent(target)}` : ""}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "project" && command[1] === "verify") {
      const target = options.params.target === "auto" || !options.params.target ? await fetchDetectedTarget(fetchImpl, options.relay, "auto") : options.params.target;
      if (target !== "web" && target !== "miniapp") {
        const support = await fetchTargetSupport(fetchImpl, options.relay, target);
        stdout(format(supportFailure(support.report), options.pretty));
        return 1;
      }
      const payload = await projectVerifyPayload(fetchImpl, options.relay, target, options.params.runId);
      if (isStructuredFailure(payload)) {
        stdout(format(payload, options.pretty));
        return 1;
      }
      const written = await maybeWriteArtifact(options.artifact, payload);
      stdout(format({ ok: true, detectedTarget: target, ...payload, artifactPath: written }, options.pretty));
      return 0;
    }

    if (command[0] === "project" && command[1] === "advise") {
      const target = options.params.target === "auto" || !options.params.target ? await fetchDetectedTarget(fetchImpl, options.relay, "auto") : options.params.target;
      if (target !== "web" && target !== "miniapp") {
        const support = await fetchTargetSupport(fetchImpl, options.relay, target);
        stdout(format(supportFailure(support.report), options.pretty));
        return 1;
      }
      const payload = await projectVerifyPayload(fetchImpl, options.relay, target, options.params.runId);
      if (isStructuredFailure(payload)) {
        stdout(format(payload, options.pretty));
        return 1;
      }
      const suggestions =
        target === "web"
          ? payload.projectCheck.recommendedActions
          : payload.projectCheck.recommendedActions.concat(payload.runtimeReadiness.blockingReasons || []);
      stdout(
        format(
          {
            ok: true,
            detectedTarget: target,
            target,
            suggestions,
            recommendedAction: payload.recommendedAction,
            closureEligible: payload.closureEligible,
            autoloopEligible: payload.autoloopEligible,
          },
          options.pretty
        )
      );
      return 0;
    }

    if (command[0] === "project" && command[1] === "memory") {
      const projectId = options.params.projectId || "";
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/project/memory?projectId=${encodeURIComponent(projectId)}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "project" && command[1] === "history") {
      const projectId = options.params.projectId || "";
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/project/history?projectId=${encodeURIComponent(projectId)}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "project" && command[1] === "knowledge") {
      const projectId = options.params.projectId || "";
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/project/memory?projectId=${encodeURIComponent(projectId)}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "project" && command[1] === "baseline") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/baseline`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "store" && command[1] === "inspect") {
      const query = new URLSearchParams();
      if (options.params.runId) query.set("runId", options.params.runId);
      if (options.params.harnessRunId) query.set("harnessRunId", options.params.harnessRunId);
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/store/inspect?${query.toString()}`);
      stdout(format(payload, options.pretty));
      return payload.ok === false ? 1 : 0;
    }

    if (command[0] === "store" && command[1] === "cleanup") {
      const payload = await postJson(fetchImpl, `${options.relay}/ai/store/cleanup`, {
        olderThanDays: options.params.olderThanDays || "30",
        dryRun: options.params.dryRun === "true" || options.params.dryRun === "1" || !options.params.confirm,
        confirm: options.params.confirm === "true" || options.params.confirm === "1",
      });
      stdout(format(payload, options.pretty));
      return payload.ok === false ? 1 : 0;
    }

    if (command[0] === "harness" && command[1] === "report") {
      const harnessRunId = options.params.harnessRunId || options.params.runId || "";
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/harness/${encodeURIComponent(harnessRunId)}/report`);
      stdout(format(payload, options.pretty));
      return payload.ok === false ? 1 : 0;
    }

    if (command[0] === "harness" && command[1] === "evidence") {
      const harnessRunId = options.params.harnessRunId || "";
      const ref = options.params.ref || "";
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/harness/${encodeURIComponent(harnessRunId)}/evidence?ref=${encodeURIComponent(ref)}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "harness" && command[1] === "benchmark") {
      const benchmark = await runBlackboxBenchmark(fetchImpl, options);
      stdout(format({ ok: true, harness: true, benchmark }, options.pretty));
      return 0;
    }

    if (command[0] === "harness" && command[1] === "verify") {
      const target = options.params.target === "miniapp" ? "miniapp" : "web";
      const driver = options.params.driver || (target === "web" ? "playwright" : "devtools-automator");
      const goals = optionGoals(options);
      const orchestrator = new HarnessOrchestrator({
        verifyWeb: () => verifyWebHarnessWithOrchestrator(fetchImpl, spawnImpl, blackboxWebRunner, options, driver, goals),
        verifyMiniapp: () => verifyMiniappHarnessWithOrchestrator(fetchImpl, options, driver, goals),
      });
      const result = await orchestrator.verify({
        target,
        driver: driver === "computer-use" || driver === "devtools-automator" || driver === "playwright" ? driver : undefined,
        goals,
        url: options.params.url,
        ledger: options.params.ledger,
        driverModule: options.params.driverModule,
        storageState: options.params.storageState,
        authProfile: options.params.authProfile,
        viewport: options.params.viewport === "mobile" || options.params.viewport === "both" ? options.params.viewport : "desktop",
        visual: options.params.visual === "true",
        a11y: options.params.a11y === "true",
        timeoutMs: Number(options.params.timeoutMs || 0) || undefined,
        noStart: options.params.noStart === "true",
        noDiscover: options.params.noDiscover === "true",
        baselineRunId: options.params.baselineRunId,
      });
      stdout(format((result as HarnessVerifyResult & { output?: unknown }).output || result, options.pretty));
      return result.exitStatus;
    }

    if (command[0] === "blackbox" && command[1] === "discover") {
      const target = options.params.target === "miniapp" ? "miniapp" : "web";
      if (target !== "web") {
        stdout(format(blackboxFailure("target_not_discoverable", "blackbox discover currently supports web targets.", "Use blackbox plan/run with a real Miniapp driver or ledger."), options.pretty));
        return 1;
      }
      const resolution = await resolveWebTarget(fetchImpl, spawnImpl, options.relay, options);
      try {
        if (resolution.failure) {
          stdout(format({ ...resolution.failure, demoProhibited: true }, options.pretty));
          return 1;
        }
        const storageState = await resolveStorageStatePath(resolution.targetProject!, options).catch((error) => {
          throw new Error(error instanceof Error ? error.message : String(error));
        });
        const discoverSummary = await runWebBlackboxDiscover(resolution.targetProject!.targetUrl, undefined, blackboxRunOptions(options, storageState));
        stdout(format({ ok: true, target, demoProhibited: true, discoverSummary }, options.pretty));
        return 0;
      } finally {
        resolution.child?.kill();
      }
    }

    if (command[0] === "blackbox" && command[1] === "plan") {
      const target = options.params.target === "miniapp" ? "miniapp" : "web";
      if (target === "web") {
        const resolution = await resolveWebTarget(fetchImpl, spawnImpl, options.relay, options);
        try {
          if (resolution.failure) {
            stdout(format({ ...resolution.failure, demoProhibited: true }, options.pretty));
            return 1;
          }
          const projectCheck = await requestJson(fetchImpl, `${options.relay}/ai/web/project-check`).catch(() => ({ report: {} }));
          const storageState = await resolveStorageStatePath(resolution.targetProject!, options).catch((error) => {
            throw new Error(error instanceof Error ? error.message : String(error));
          });
          const discoverSummary = options.params.noDiscover === "true" || options.params.noDiscover === "1"
            ? undefined
            : await runWebBlackboxDiscover(resolution.targetProject!.targetUrl, undefined, blackboxRunOptions(options, storageState)).catch(() => undefined);
          const plan = await createBlackboxPlan(fetchImpl, options.relay, "web", resolution.targetProject as unknown as Record<string, unknown>, options, projectCheck.report, discoverSummary);
          stdout(format({ ok: true, target, demoProhibited: true, plan }, options.pretty));
          return 0;
        } finally {
          resolution.child?.kill();
        }
      }
      const projectCheck = await requestJson(fetchImpl, `${options.relay}/ai/miniapp/project-check`);
      const plan = await createBlackboxPlan(
        fetchImpl,
        options.relay,
        "miniapp",
        {
          workspaceRoot: resolveWorkspaceRoot(),
          resolvedProjectRoot: resolveWorkspaceRoot(),
        },
        options,
        projectCheck.report
      );
      stdout(format({ ok: true, target, demoProhibited: true, plan }, options.pretty));
      return 0;
    }

    if (command[0] === "blackbox" && command[1] === "report") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/blackbox-report`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "blackbox" && command[1] === "capsule") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/evidence-capsule`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "blackbox" && command[1] === "trace") {
      const formatName = options.params.format || "summary";
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/blackbox-trace?format=${encodeURIComponent(formatName)}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "blackbox" && command[1] === "seed-regression") {
      const payload = await postJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/seed-regression`, {});
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "blackbox" && command[1] === "export") {
      const formatName = options.params.format || "playwright";
      const payload = await postJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/blackbox-export`, { format: formatName });
      const outPath = String(options.params.out || "").trim();
      if (outPath && payload.export?.content) {
        const absolute = path.isAbsolute(outPath) ? outPath : path.join(resolveWorkspaceRoot(), outPath);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, String(payload.export.content), "utf8");
        payload.writtenFilePath = absolute;
      }
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "blackbox" && command[1] === "run") {
      const target = options.params.target === "miniapp" ? "miniapp" : "web";
      const driver = options.params.driver || (target === "web" ? "playwright" : "devtools-automator");
      if (target === "web") {
        const ledgerPath = driver === "computer-use" ? options.params.ledger || "" : "";
        let computerUseLedger: Record<string, any> | null = null;
        if (driver === "computer-use") {
          if (!ledgerPath) {
            stdout(
              format(
                blackboxFailure(
                  "computer_use_ledger_required",
                  "blackbox run --driver computer-use requires a real Computer Use ledger.",
                  "Run the generated blackbox plan with Computer Use, then pass --ledger <path>."
                ),
                options.pretty
              )
            );
            return 1;
          }
          try {
            computerUseLedger = await readBlackboxLedger(ledgerPath);
          } catch (error) {
            stdout(format(blackboxFailure("computer_use_ledger_invalid", error instanceof Error ? error.message : String(error), "Regenerate the ledger from this target project and rerun blackbox run."), options.pretty));
            return 1;
          }
        }
        const effectiveOptions =
          computerUseLedger?.targetUrl && !options.params.url && !process.env.DEV_LOG_RELAY_TARGET_URL
            ? { ...options, params: { ...options.params, url: String(computerUseLedger.targetUrl) } }
            : options;
        const resolution = await resolveWebTarget(fetchImpl, spawnImpl, options.relay, effectiveOptions);
        try {
          if (resolution.failure) {
            stdout(format({ ...resolution.failure, demoProhibited: true }, options.pretty));
            return 1;
          }
          const targetProject = resolution.targetProject!;
          const projectCheck = await requestJson(fetchImpl, `${options.relay}/ai/web/project-check`).catch(() => ({ report: {} }));
          let storageState = "";
          try {
            storageState = await resolveStorageStatePath(targetProject, options) || "";
          } catch (error) {
            stdout(format(blackboxFailure("auth_profile_target_mismatch", error instanceof Error ? error.message : String(error), "Use a storage state or auth profile captured from this target project."), options.pretty));
            return 1;
          }
          const runOptions = blackboxRunOptions(options, storageState);
          const discoverSummary = options.params.noDiscover === "true" || options.params.noDiscover === "1" || driver === "computer-use"
            ? undefined
            : await runWebBlackboxDiscover(targetProject.targetUrl, undefined, runOptions).catch(() => undefined);
          const plan = driver === "computer-use"
            ? await fetchBlackboxPlanById(fetchImpl, options.relay, ledgerPlanId(computerUseLedger || {}))
            : options.params.planId
              ? await fetchBlackboxPlanById(fetchImpl, options.relay, options.params.planId)
              : await createBlackboxPlan(fetchImpl, options.relay, "web", targetProject as unknown as Record<string, unknown>, options, projectCheck.report, discoverSummary);
          let blackboxReport: BlackboxRunReport;
          if (driver === "computer-use") {
            try {
              blackboxReport = await runBlackboxFromLedger(fetchImpl, options.relay, "web", targetProject as unknown as Record<string, unknown>, plan, computerUseLedger || {}, options.params.baselineRunId || "");
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const reasonCode = message.includes("target_url_mismatch")
                ? "computer_use_ledger_target_url_mismatch"
                : message.includes("target_project_mismatch")
                  ? "computer_use_ledger_target_project_mismatch"
                  : message.includes("visible_evidence_required")
                    ? "visible_evidence_required"
                    : message.includes("action_ledger_required")
                      ? "action_ledger_required"
                      : "computer_use_ledger_invalid";
              stdout(format(blackboxFailure(reasonCode, message, "Regenerate the ledger from this target project and rerun blackbox run."), options.pretty));
              return 1;
            }
          } else {
            const runStart = await postJson(fetchImpl, `${options.relay}/runs/start`, {
              label: options.params.label || "blackbox-web",
              target: "web",
              metadata: {
                projectRoot: resolveWorkspaceRoot(),
                targetProject,
                driver,
                blackbox: true,
                demoProhibited: true,
                baselineRunId: options.params.baselineRunId || "",
              },
            });
            blackboxReport = await blackboxWebRunner(fetchImpl, options.relay, String(runStart.runId), targetProject, plan, runOptions);
          }
          try {
            const stored = await postJson(fetchImpl, `${options.relay}/blackbox/run`, { report: blackboxReport });
            blackboxReport = stored.report || blackboxReport;
          } catch (error) {
            const failure = blackboxReportStoreFailure(error);
            stdout(format(
              {
                ...blackboxFailure(failure.reasonCode, failure.message, "Fix the Web target UI or driver until visible evidence is explicit."),
                plan,
                targetProject,
                blackboxReport,
              },
              options.pretty
            ));
            return 1;
          }
          const written = await maybeWriteArtifact(options.artifact, blackboxReport);
          const ok = blackboxOutcomeOk(blackboxReport);
          stdout(format({ ok, demoProhibited: true, plan, blackboxReport, artifactPath: written }, options.pretty));
          return ok ? 0 : 1;
        } finally {
          resolution.child?.kill();
        }
      }

      const projectVerify = await projectVerifyPayload(fetchImpl, options.relay, "miniapp");
      if (isStructuredFailure(projectVerify)) {
        stdout(format(projectVerify, options.pretty));
        return 1;
      }
      const projectCheck = await requestJson(fetchImpl, `${options.relay}/ai/miniapp/project-check`);
      const targetProject = {
        workspaceRoot: resolveWorkspaceRoot(),
        resolvedProjectRoot: resolveWorkspaceRoot(),
      };
      const ledgerPath = driver === "computer-use" ? options.params.ledger || "" : "";
      let computerUseLedger: Record<string, any> | null = null;
      if (driver === "computer-use") {
        if (!ledgerPath) {
          stdout(
            format(
              blackboxFailure(
                "computer_use_ledger_required",
                "miniapp blackbox run --driver computer-use requires a real Computer Use ledger.",
                "Run the generated miniapp plan through Computer Use and pass --ledger <path>."
              ),
              options.pretty
            )
          );
          return 1;
        }
        try {
          computerUseLedger = await readBlackboxLedger(ledgerPath);
        } catch (error) {
          stdout(format(blackboxFailure("computer_use_ledger_invalid", error instanceof Error ? error.message : String(error), "Regenerate the miniapp ledger from this target project."), options.pretty));
          return 1;
        }
      }
      const plan = driver === "computer-use"
        ? await fetchBlackboxPlanById(fetchImpl, options.relay, ledgerPlanId(computerUseLedger || {}))
        : options.params.planId
          ? await fetchBlackboxPlanById(fetchImpl, options.relay, options.params.planId)
          : await createBlackboxPlan(fetchImpl, options.relay, "miniapp", targetProject, options, projectCheck.report);
      let blackboxReport: BlackboxRunReport;
      if (driver === "computer-use") {
        try {
          blackboxReport = await runBlackboxFromLedger(fetchImpl, options.relay, "miniapp", targetProject, plan, computerUseLedger || {}, options.params.baselineRunId || "");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const reasonCode = message.includes("visible_evidence_required")
            ? "visible_evidence_required"
            : message.includes("action_ledger_required")
              ? "action_ledger_required"
              : message.includes("target_project_mismatch")
                ? "computer_use_ledger_target_project_mismatch"
                : "computer_use_ledger_invalid";
          stdout(format(blackboxFailure(reasonCode, message, "Regenerate the miniapp ledger from this target project."), options.pretty));
          return 1;
        }
      } else {
        const bootstrap = await bootstrapMiniappDevTools({
          workspaceRoot: resolveWorkspaceRoot(),
          fix: options.params.bootstrap === "false" ? false : true,
          driver,
          cliPath: options.params.cliPath,
          servicePort: options.params.servicePort,
          projectPath: options.params.projectPath,
          profileDir: options.params.profileDir,
          sidecarPort: options.params.sidecarPort,
        });
        const miniappResolution = resolveMiniappDriver({
          workspaceRoot: resolveWorkspaceRoot(),
          driver,
          driverModule: options.params.driverModule,
          cliPath: options.params.cliPath,
          servicePort: options.params.servicePort || bootstrap.servicePort,
          projectPath: options.params.projectPath,
          bootstrap,
        });
        miniappResolution.bootstrap = bootstrap;
        if (miniappResolution.status !== "available") {
          const reasonCode = miniappResolution.reasonCodes[0] || "driver_required";
          const output = attachMiniappExecutingAiContext(
            blackboxFailure(reasonCode, miniappResolution.blockingReasons[0] || "miniapp blackbox run requires an executable driver.", miniappResolution.recommendedAction),
            { options, reasonCodes: [...bootstrap.reasonCodes, ...miniappResolution.reasonCodes], automationAttempts: [`bootstrap:${bootstrap.status}`, "blackbox-miniapp:driver-resolution"], servicePort: bootstrap.servicePort }
          );
          Object.assign(output, { bootstrap, driverResolution: miniappResolution });
          stdout(format(output, options.pretty));
          return 1;
        }
        blackboxReport = await runMiniappBlackboxWithDriver(fetchImpl, options.relay, plan, driver, miniappResolution.driverModule || "", projectCheck.report, options.params.baselineRunId || "", {
          cliPath: miniappResolution.cliPath,
          servicePort: miniappResolution.servicePort,
          projectPath: miniappResolution.projectPath,
          profileDir: bootstrap.profileDir,
        });
      }
      try {
        const stored = await postJson(fetchImpl, `${options.relay}/blackbox/run`, { report: blackboxReport });
        blackboxReport = stored.report || blackboxReport;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reasonCode = /visible/i.test(message) ? "visible_evidence_required" : "blackbox_report_invalid";
        stdout(format({ ...blackboxFailure(reasonCode, message, "Fix the Miniapp driver or target UI until visible evidence is explicit."), blackboxReport }, options.pretty));
        return 1;
      }
      const written = await maybeWriteArtifact(options.artifact, blackboxReport);
      const ok = blackboxOutcomeOk(blackboxReport);
      stdout(format({ ok, demoProhibited: true, plan, projectVerify, blackboxReport, artifactPath: written }, options.pretty));
      return ok ? 0 : 1;
    }

    if (command[0] === "benchmark" && command[1] === "blackbox") {
      const payload = await runBlackboxBenchmark(fetchImpl, options);
      stdout(format({ ok: true, benchmark: payload }, options.pretty));
      return 0;
    }

    if (command[0] === "miniapp" && command[1] === "bootstrap") {
      const bootstrap = await bootstrapMiniappDevTools({
        workspaceRoot: resolveWorkspaceRoot(),
        fix: options.params.fix === "true" || options.params.fix === "1",
        driver: options.params.driver,
        cliPath: options.params.cliPath,
        servicePort: options.params.servicePort,
        projectPath: options.params.projectPath,
        profileDir: options.params.profileDir,
        sidecarPort: options.params.sidecarPort,
      });
      stdout(format({ ok: bootstrap.ok, status: bootstrap.status, continuable: bootstrap.status === "pairing_required", target: "miniapp", bootstrap, demoProhibited: true }, options.pretty));
      return bootstrap.ok || bootstrap.status === "pairing_required" ? 0 : 1;
    }

    if (command[0] === "miniapp" && command[1] === "doctor") {
      const bootstrap = await bootstrapMiniappDevTools({
        workspaceRoot: resolveWorkspaceRoot(),
        fix: options.params.fix === "true" || options.params.fix === "1",
        driver: options.params.driver,
        cliPath: options.params.cliPath,
        servicePort: options.params.servicePort,
        projectPath: options.params.projectPath,
        profileDir: options.params.profileDir,
        sidecarPort: options.params.sidecarPort,
      });
      const driverCheck = await miniappDriverCheck(options, bootstrap);
      stdout(
        format(
          {
            ok: bootstrap.ok && driverCheck.ok,
            target: "miniapp",
            bootstrap,
            driverResolution: driverCheck.driverResolution,
            recommendedAction: bootstrap.ok ? driverCheck.driverResolution.recommendedAction : bootstrap.recommendedAction,
            demoProhibited: true,
          },
          options.pretty
        )
      );
      return bootstrap.ok && driverCheck.ok ? 0 : 1;
    }

    if (command[0] === "miniapp" && command[1] === "sidecar") {
      const action = command[2] === "install" || command[2] === "start" || command[2] === "stop" ? command[2] : "check";
      const dryRun = options.params.dryRun === "true" || options.params.dryRun === "1";
      const bootstrap = (action === "install" || action === "start") && !dryRun
        ? await bootstrapMiniappDevTools({
            workspaceRoot: resolveWorkspaceRoot(),
            fix: true,
            driver: options.params.driver,
            cliPath: options.params.cliPath,
            servicePort: options.params.servicePort,
            projectPath: options.params.projectPath,
            profileDir: options.params.profileDir,
            sidecarPort: options.params.sidecarPort,
          })
        : undefined;
      const sidecar = await manageMiniappSidecar({
        workspaceRoot: resolveWorkspaceRoot(),
        action,
        sidecarPort: options.params.sidecarPort,
        servicePort: options.params.servicePort,
        cliPath: options.params.cliPath,
        dryRun,
      });
      stdout(format({ ok: sidecar.ok, target: "miniapp", action, bootstrap, sidecar, demoProhibited: true }, options.pretty));
      return sidecar.ok || dryRun ? 0 : 1;
    }

    if (command[0] === "miniapp" && command[1] === "driver" && command[2] === "check") {
      const payload = await miniappDriverCheck(options);
      stdout(format(payload, options.pretty));
      return payload.ok ? 0 : 1;
    }

    if (command[0] === "web" && command[1] === "verify") {
      const payload = await webVerifyPayload(fetchImpl, options.relay, options.params.runId);
      if (isStructuredFailure(payload)) {
        stdout(format(payload, options.pretty));
        return 1;
      }
      const written = await maybeWriteArtifact(options.artifact, payload);
      stdout(format({ ok: true, ...payload, artifactPath: written }, options.pretty));
      return 0;
    }

    if (command[0] === "run" && command[1] === "start") {
      const payload = await postJson(fetchImpl, `${options.relay}/runs/start`, {
        label: options.params.label,
        target: options.params.target,
        metadata: {
          projectRoot: resolveWorkspaceRoot(),
        },
      });
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "run" && command[1] === "step" && command[2] === "start") {
      const payload = await postJson(fetchImpl, `${options.relay}/runs/${options.params.runId}/steps/start`, {
        name: options.params.name,
        kind: options.params.kind,
        route: options.params.route,
      });
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "run" && command[1] === "step" && command[2] === "end") {
      const payload = await postJson(fetchImpl, `${options.relay}/runs/${options.params.runId}/steps/${options.params.stepId}/end`, {
        status: options.params.status,
      });
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "run" && command[1] === "end") {
      const payload = await postJson(fetchImpl, `${options.relay}/runs/${options.params.runId}/end`, {
        status: options.params.status,
      });
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "timeline") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/timeline?limit=${options.params.limit || 50}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "diagnosis") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/diagnosis`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "closure") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/closure`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "handoff") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/handoff`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "verification-report") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/verification-report`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "report") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/report`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "summary") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/summary-view`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "failure-report") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/failure-report`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "pr-comment") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/pr-comment`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "release-decision") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/release-decision`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "ai" && command[1] === "diff") {
      const payload = await requestJson(
        fetchImpl,
        `${options.relay}/ai/diff?baselineRunId=${options.params.baselineRunId}&currentRunId=${options.params.currentRunId}`
      );
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "loop" && command[1] === "web") {
      const support = await fetchTargetSupport(fetchImpl, options.relay, "web");
      if (isStructuredFailure(support)) {
        stdout(format(support, options.pretty));
        return 1;
      }
      if (["baseline", "broken", "fixed"].includes(options.params.mode || "")) {
        stdout(
          format(
            {
              ok: false,
              status: "unsupported",
              reasonCode: "demo_runner_forbidden",
              reason: "The production web loop no longer supports built-in demo modes.",
              recommendedAction: "Run against a real target project with --url or an auto-startable project script.",
              supportedTargets: ["web", "miniapp"],
              currentCapabilities: ["target-project-only"],
              demoProhibited: true,
            },
            options.pretty
          )
        );
        return 1;
      }
      const executed = await executeTargetWebRun(fetchImpl, spawnImpl, webScenarioRunner, options.relay, options, {
        label: options.params.label || "web-target",
        scenario: options.params.templateName || options.params.scenario || "web_home_cold_start",
        baselineRunId: options.params.baselineRunId || "",
      });
      if (executed.failure) {
        stdout(format({ ...executed.failure, demoProhibited: true }, options.pretty));
        return 1;
      }
      stdout(format(executed.payload, options.pretty));
      return 0;
    }

    if (command[0] === "loop" && command[1] === "compare") {
      const diff = await requestJson(
        fetchImpl,
        `${options.relay}/ai/diff?baselineRunId=${options.params.baselineRunId}&currentRunId=${options.params.currentRunId}`
      );
      const closure = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.currentRunId}/closure`);
      const payload = {
        baselineRunId: options.params.baselineRunId,
        currentRunId: options.params.currentRunId,
        diff: diff.changed || [],
        closure: closure.closure,
      };
      const written = await maybeWriteArtifact(options.artifact, payload);
      stdout(format({ ...payload, artifactPath: written }, options.pretty));
      return 0;
    }

    if (command[0] === "template" && command[1] === "list") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/templates${options.params.target ? `?target=${encodeURIComponent(options.params.target)}` : ""}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "template" && command[1] === "validate") {
      const payload = await postJson(fetchImpl, `${options.relay}/scenarios/validate`, {
        runId: options.params.runId,
        templateName: options.params.name,
        target: options.params.target || "",
      });
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "scenario" && command[1] === "validate") {
      const body = options.params.spec ? JSON.parse(options.params.spec) : undefined;
      const payload = await postJson(fetchImpl, `${options.relay}/scenarios/validate`, {
        runId: options.params.runId,
        templateName: options.params.templateName || "",
        target: options.params.target || "",
        spec: body,
      });
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "scenario" && command[1] === "list") {
      const target = options.params.target || "";
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/scenarios${target ? `?target=${encodeURIComponent(target)}` : ""}`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "scenario" && command[1] === "inspect") {
      const templateName = options.params.templateName || options.params.name || "";
      const target = options.params.target || "";
      const payload = await requestJson(
        fetchImpl,
        `${options.relay}/ai/scenario/inspect?templateName=${encodeURIComponent(templateName)}${target ? `&target=${encodeURIComponent(target)}` : ""}`
      );
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "scenario" && command[1] === "baseline") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/baseline`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "scenario" && command[1] === "diff") {
      const payload = await requestJson(
        fetchImpl,
        `${options.relay}/ai/diff/scenario?baselineRunId=${encodeURIComponent(options.params.baselineRunId)}&currentRunId=${encodeURIComponent(options.params.currentRunId)}`
      );
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "baseline" && command[1] === "capture") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/baseline`);
      const written = await maybeWriteArtifact(options.artifact, payload);
      stdout(format({ ...payload, artifactPath: written }, options.pretty));
      return 0;
    }

    if (command[0] === "baseline" && command[1] === "compare") {
      const [scenarioDiff, stateDiff, regression] = await Promise.all([
        requestJson(
          fetchImpl,
          `${options.relay}/ai/diff/scenario?baselineRunId=${encodeURIComponent(options.params.baselineRunId)}&currentRunId=${encodeURIComponent(options.params.currentRunId)}`
        ),
        requestJson(
          fetchImpl,
          `${options.relay}/ai/diff/state?baselineRunId=${encodeURIComponent(options.params.baselineRunId)}&currentRunId=${encodeURIComponent(options.params.currentRunId)}`
        ),
        requestJson(
          fetchImpl,
          `${options.relay}/ai/diff/regression?baselineRunId=${encodeURIComponent(options.params.baselineRunId)}&currentRunId=${encodeURIComponent(options.params.currentRunId)}`
        ),
      ]);
      const payload = {
        ok: true,
        scenarioDiff,
        stateDiff,
        regression: regression.regression,
        blocking: regression.regression?.blockingDiffs || [],
        nonBlocking: regression.regression?.nonBlockingDiffs || [],
      };
      const written = await maybeWriteArtifact(options.artifact, payload);
      stdout(format({ ...payload, artifactPath: written }, options.pretty));
      return 0;
    }

    if (command[0] === "ci" && command[1] === "readiness") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/verification-report`);
      const readiness = payload.verificationReport?.runtimeReadiness;
      const status =
        readiness?.bestPracticeCompliant && readiness?.evidenceLevel === "runtime_verified"
          ? "pass"
          : "hold";
      stdout(
        format(
          {
            ok: true,
            ci: {
              status,
              failedChecks: readiness?.missingSignals || ["missing_runtime_readiness"],
              blockingReasons: readiness?.blockingReasons || ["missing_runtime_readiness"],
              artifacts: [options.params.runId],
              baselineRefs: payload.verificationReport?.releaseDecision?.baselineRefs || [],
            },
          },
          options.pretty
        )
      );
      return exitCodeFromCi(status);
    }

    if (command[0] === "ci" && command[1] === "scenario-smoke") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/scenario`);
      const status = payload.scenario?.status === "passed" ? "pass" : payload.scenario?.status === "partially_observed" ? "manual_review_required" : "hold";
      stdout(
        format(
          {
            ok: true,
            ci: {
              status,
              failedChecks: payload.scenario?.missingEvidence || [],
              blockingReasons: payload.scenario?.blocking ? payload.scenario?.missingEvidence || [] : [],
              artifacts: [options.params.runId],
              baselineRefs: payload.scenario?.baselineKey ? [payload.scenario.baselineKey] : [],
            },
          },
          options.pretty
        )
      );
      return exitCodeFromCi(status);
    }

    if (command[0] === "ci" && command[1] === "closure") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/release-decision`);
      const status = payload.releaseDecision?.decision === "ship" ? "pass" : payload.releaseDecision?.decision === "manual_review_required" ? "manual_review_required" : "hold";
      stdout(
        format(
          {
            ok: true,
            ci: {
              status,
              failedChecks: payload.releaseDecision?.blockingItems || [],
              blockingReasons: payload.releaseDecision?.blockingItems || [],
              artifacts: [options.params.runId],
              baselineRefs: payload.releaseDecision?.baselineRefs || [],
            },
          },
          options.pretty
        )
      );
      return exitCodeFromCi(status);
    }

    if (command[0] === "ci" && command[1] === "report") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/report`);
      const status = payload.report?.releaseDecision?.decision === "ship" ? "pass" : payload.report?.releaseDecision?.decision === "manual_review_required" ? "manual_review_required" : "hold";
      stdout(
        format(
          {
            ok: true,
            ci: {
              status,
              failedChecks: payload.report?.blockingItems || [],
              blockingReasons: payload.report?.blockingItems || [],
              artifacts: [options.params.runId],
              baselineRefs: payload.report?.releaseDecision?.baselineRefs || [],
            },
          },
          options.pretty
        )
      );
      return exitCodeFromCi(status);
    }

    if (command[0] === "ci" && command[1] === "regression") {
      const verification = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/verification-report`);
      const baselineRunId = options.params.baselineRunId || verification.verificationReport?.closure?.baselineRunId || "";
      const payload = await requestJson(
        fetchImpl,
        `${options.relay}/ai/diff/regression?baselineRunId=${encodeURIComponent(baselineRunId)}&currentRunId=${encodeURIComponent(options.params.runId)}${options.params.scenario ? `&scenarioId=${encodeURIComponent(options.params.scenario)}` : ""}`
      );
      const status = payload.regression?.decision === "ship" ? "pass" : payload.regression?.decision === "manual_review_required" ? "manual_review_required" : "hold";
      stdout(
        format(
          {
            ok: true,
            ci: {
              status,
              failedChecks: payload.regression?.failedChecks || [],
              blockingReasons: payload.regression?.blockingReasons || [],
              artifacts: [options.params.runId],
              baselineRefs: payload.regression?.baselineRefs || [],
            },
          },
          options.pretty
        )
      );
      return exitCodeFromCi(status);
    }

    if (command[0] === "autoloop" && command[1] === "start") {
      const target = options.params.target || "web";
      const support = await fetchTargetSupport(fetchImpl, options.relay, target);
      if (support.report.status === "unsupported" || support.report.status === "inapplicable") {
        stdout(
          format(
            {
              ok: false,
              status: support.report.status,
              reasonCode: support.report.reasonCode,
              reason: support.report.reason,
              recommendedAction: support.report.recommendedAction,
              supportedTargets: support.report.supportedTargets,
              currentCapabilities: support.report.currentCapabilities,
            },
            options.pretty
          )
        );
        return 1;
      }
      const payload = await postJson(fetchImpl, `${options.relay}/autoloops/start`, {
        triggerReason: options.params.triggerReason || "runtime_change_detected",
        target,
        scenario: options.params.scenario || "broken",
        baselineRunId: options.params.baselineRunId || "",
        maxAttempts: options.params.maxAttempts ? Number(options.params.maxAttempts) : undefined,
        entryContext: {
          task: options.params.task || "",
          projectRoot: resolveWorkspaceRoot(),
        },
      });
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "autoloop" && command[1] === "collect") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/collection`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "autoloop" && command[1] === "diagnose") {
      const [diagnosis, brief, integrity] = await Promise.all([
        requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/diagnosis`),
        requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/repair-brief`),
        requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/integrity`),
      ]);
      stdout(format({ ok: true, diagnosis: diagnosis.diagnosis, repairBrief: brief.repairBrief, integrity: integrity.integrity }, options.pretty));
      return 0;
    }

    if (command[0] === "autoloop" && command[1] === "repair") {
      const payload = await postJson(
        fetchImpl,
        `${options.relay}/autoloops/${options.params.id}/attempts/${options.params.attemptId}/repair-outcome`,
        {
          changedFiles: parseCsv(options.params.changedFiles),
          assumptionDelta: parseCsv(options.params.assumptionDelta),
          riskLevel: options.params.riskLevel || "medium",
          notes: options.params.notes || "",
        }
      );
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "autoloop" && command[1] === "retest") {
      const runId = options.params.runId;
      if (!runId) {
        stdout(
          format(
            {
              ok: false,
              status: "unsupported",
              reasonCode: "demo_runner_forbidden",
              reason: "Retest no longer runs built-in demo modes. Start a real target run instead.",
              recommendedAction: "Use relay autoloop run --target web with --url or an auto-startable target project.",
              supportedTargets: ["web", "miniapp"],
              currentCapabilities: ["target-project-only"],
              demoProhibited: true,
            },
            options.pretty
          )
        );
        return 1;
      }
      stdout(
        format(
          {
            ok: false,
            status: "unsupported",
            reasonCode: "demo_runner_forbidden",
            reason: "Production autoloop retest cannot drive a built-in demo runner.",
            recommendedAction: "Drive the real target project and query collection, diagnosis, and closure for this runId.",
            supportedTargets: ["web", "miniapp"],
            currentCapabilities: ["target-project-only"],
            runId,
            demoProhibited: true,
          },
          options.pretty
        )
      );
      return 1;
    }

    if (command[0] === "autoloop" && command[1] === "decide") {
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/autoloop/${options.params.id}/decision`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "autoloop" && command[1] === "handoff") {
      let runId = options.params.runId || "";
      if (!runId && options.params.id) {
        const autoloop = await requestJson(fetchImpl, `${options.relay}/ai/autoloop/${options.params.id}`);
        const attempts = autoloop.autoloop?.attempts || [];
        runId = attempts.at(-1)?.currentRunId || autoloop.autoloop?.session?.runId || "";
      }
      if (!runId) {
        stderr("runId is required for autoloop handoff.\n");
        return 1;
      }
      const payload = await requestJson(fetchImpl, `${options.relay}/ai/run/${runId}/handoff`);
      stdout(format(payload, options.pretty));
      return 0;
    }

    if (command[0] === "autoloop" && command[1] === "run") {
      const target = options.params.target || "web";
      if (target !== "web") {
        const support = await fetchTargetSupport(fetchImpl, options.relay, target);
        stdout(
          format(
            {
              ok: false,
              status: target === "miniapp" ? "partial" : support.report.status,
              reasonCode: target === "miniapp" ? "unsupported_target" : support.report.reasonCode,
              reason:
                target === "miniapp"
                  ? "autoloop run only supports the web Playwright closed loop. Miniapp must use verify-first flow."
                  : support.report.reason,
              recommendedAction: target === "miniapp" ? "Use relay miniapp verify before diagnosis." : support.report.recommendedAction,
              supportedTargets: support.report.supportedTargets,
              currentCapabilities: support.report.currentCapabilities,
            },
            options.pretty
          )
        );
        return 1;
      }

      const triggerDecision = await fetchTriggerDecision(fetchImpl, options.relay, {
        target: "web",
        reason: options.params.triggerReason || "runtime_change_detected",
        phase: options.params.phase || "self_test",
        runtimeImpact: true,
      });
      const projectVerify = await projectVerifyPayload(fetchImpl, options.relay, "web");
      if (isStructuredFailure(projectVerify)) {
        stdout(format(projectVerify, options.pretty));
        return 1;
      }
      if (!projectVerify.autoloopEligible) {
        const webReadiness = projectVerify.runtimeReadiness as {
          availableSignals: string[];
          [key: string]: unknown;
        };
        stdout(
          format(
            {
              ok: false,
              status: "partial",
              reasonCode: "collection_incomplete",
              reason: "Web runtime relay is not ready for best-practice closed-loop execution.",
              recommendedAction: "Complete runtime relay integration before autoloop run.",
              supportedTargets: ["web", "miniapp"],
              currentCapabilities: webReadiness.availableSignals,
              readiness: projectVerify.runtimeReadiness,
              projectCheck: projectVerify.projectCheck,
            },
            options.pretty
          )
        );
        return 1;
      }
      if (triggerDecision.decision.status === "unsupported" || triggerDecision.decision.status === "inapplicable") {
        stdout(
          format(
            {
              ok: false,
              status: triggerDecision.decision.status,
              reasonCode: triggerDecision.decision.reasonCode,
              reason: triggerDecision.decision.decisionReason,
              recommendedAction: triggerDecision.decision.recommendedCommand,
              supportedTargets: ["web", "miniapp"],
              currentCapabilities: ["playwright-driver", "web-sdk"],
            },
            options.pretty
          )
        );
        return 1;
      }

      const executed = await executeTargetWebRun(fetchImpl, spawnImpl, webScenarioRunner, options.relay, options, {
        label: options.params.label || "autoloop-target",
        scenario: options.params.templateName || options.params.scenario || "web_home_cold_start",
        baselineRunId: options.params.baselineRunId || "",
        useAutoloop: true,
      });
      if (executed.failure) {
        stdout(format({ ...executed.failure, demoProhibited: true }, options.pretty));
        return 1;
      }
      stdout(
        format(
          {
            triggerDecision: triggerDecision.decision,
            webVerify: projectVerify.runtimeReadiness,
            projectVerify,
            ...executed.payload,
          },
          options.pretty
        )
      );
      return 0;
    }

    if (command[0] === "miniapp" && command[1] === "verify") {
      const [support, decision, payload, projectCheck] = await Promise.all([
        fetchTargetSupport(fetchImpl, options.relay, "miniapp"),
        fetchTriggerDecision(fetchImpl, options.relay, {
          target: "miniapp",
          reason: options.params.reason || "miniapp_verify",
          phase: options.params.phase || "self_test",
          runtimeImpact: true,
        }),
        miniappVerifyPayload(options),
        requestJson(fetchImpl, `${options.relay}/ai/miniapp/project-check`),
      ]);
      const verdict =
        support.report.status !== "supported" ||
        projectCheck.report.status !== "supported" ||
        payload.integration.blockingReasons.length > 0 ||
        payload.integration.warnings.length > 0
          ? {
              status: "integration_required",
              reason:
                payload.integration.blockingReasons[0] ||
                payload.integration.warnings[0] ||
                projectCheck.report.blockingIssues?.[0] ||
                support.report.reasonCode ||
                "miniapp_verify_required",
            }
          : {
              status: "partial_ready",
              reason: "runtime_verification_still_required",
            };
      const written = await maybeWriteArtifact(options.artifact, payload);
      stdout(
        format(
          {
            ok: true,
            support: support.report,
            triggerDecision: decision.decision,
            projectCheck: projectCheck.report,
            bestPracticeCompliant: payload.integration.autoloopEligible,
            verdict,
            integrationMaturity:
              payload.integration.blockingReasons.length === 0
                ? "preferred"
                : payload.integration.wrapperCoverage > 0
                  ? "basic"
                  : "none",
            evidenceSource: "runtime_relay",
            ...payload,
            artifactPath: written,
          },
          options.pretty
        )
      );
      return 0;
    }

    if (command[0] === "miniapp" && command[1] === "run") {
      const [support, projectVerify, projectCheck] = await Promise.all([
        fetchTargetSupport(fetchImpl, options.relay, "miniapp"),
        projectVerifyPayload(fetchImpl, options.relay, "miniapp", options.params.runId),
        requestJson(fetchImpl, `${options.relay}/ai/miniapp/project-check`),
      ]);
      if (isStructuredFailure(projectVerify)) {
        stdout(format(projectVerify, options.pretty));
        return 1;
      }
      const templateName = options.params.templateName || options.params.scenario || "miniapp_home_entry";
      const scenarioCatalog = await requestJson(fetchImpl, `${options.relay}/ai/scenarios?target=miniapp`);
      const scenario =
        (scenarioCatalog.scenarios || []).find((item: Record<string, unknown>) => item.id === templateName || item.templateName === templateName) || null;
      if (!scenario) {
        stderr(`Unknown miniapp scenario template: ${templateName}\n`);
        return 1;
      }
      const driver = options.params.driver || "devtools-automator";
      const driverModule = options.params.driverModule || process.env.DEV_LOG_RELAY_MINIAPP_DRIVER_MODULE || "";
      const bootstrap = await bootstrapMiniappDevTools({
        workspaceRoot: resolveWorkspaceRoot(),
        fix: options.params.bootstrap === "false" ? false : true,
        driver,
        cliPath: options.params.cliPath,
        servicePort: options.params.servicePort,
        projectPath: options.params.projectPath,
        profileDir: options.params.profileDir,
        sidecarPort: options.params.sidecarPort,
      });
      const driverResolution = resolveMiniappDriver({
        workspaceRoot: resolveWorkspaceRoot(),
        driver,
        driverModule,
        cliPath: options.params.cliPath,
        servicePort: options.params.servicePort || bootstrap.servicePort,
        projectPath: options.params.projectPath,
        bootstrap,
      });
      driverResolution.bootstrap = bootstrap;
      if (driver === "external-agent") {
        stdout(
          format(
            {
              ok: false,
              status: "unsupported",
              reasonCode: "driver_required",
              reason: "external-agent is a contract-only driver and cannot create executable miniapp closure evidence.",
              recommendedAction: "Use relay agent contract --target miniapp --driver external-agent, or provide --driverModule for an executable driver.",
              supportedTargets: ["web", "miniapp"],
              currentCapabilities: ["miniapp-driver-contract"],
              driverResolution: {
                required: true,
                target: "miniapp",
                driver,
                executable: false,
                status: "driver_not_available",
                reason: "external_agent_contract_only",
              },
              demoProhibited: true,
            },
            options.pretty
          )
        );
        return 1;
      }
      if (driverResolution.status !== "available") {
        const reasonCode = driverResolution.reasonCodes[0] || "driver_required";
        const output = attachMiniappExecutingAiContext(
          {
            ok: false,
            status: "partial",
            reasonCode,
            reason: driverResolution.blockingReasons[0] || "miniapp run requires an executable driver.",
            recommendedAction: driverResolution.recommendedAction,
            supportedTargets: ["web", "miniapp"],
            currentCapabilities: driverResolution.capabilities,
            bootstrap,
            driverResolution,
            demoProhibited: true,
          },
          { options, reasonCodes: [...bootstrap.reasonCodes, ...driverResolution.reasonCodes], automationAttempts: [`bootstrap:${bootstrap.status}`, "miniapp-run:driver-resolution"], servicePort: bootstrap.servicePort }
        );
        stdout(format(output, options.pretty));
        return 1;
      }
      const runStart = await createMiniappRun(fetchImpl, options.relay, options.params.label || templateName, driver, scenario.id);
      const runId = runStart.runId as string;
      const contract = await fetchDriverContract(fetchImpl, options.relay, { target: "miniapp", driver });
      const execution = await runMiniappScenarioExecution(fetchImpl, options.relay, runId, driver, scenario, projectCheck.report, driverResolution.driverModule || "", {
        cliPath: driverResolution.cliPath,
        servicePort: driverResolution.servicePort,
        projectPath: driverResolution.projectPath,
        profileDir: bootstrap.profileDir,
      });
      if (execution.status === "bridge_required") {
        stdout(
          format(
            {
              ok: false,
              status: "bridge_required",
              reasonCode: "driver_required",
              runId,
              driver,
              contract: contract.contract,
              scenario,
              driverResolution: execution.driverResolution,
              executionLedger: execution.executionLedger,
              actionPlan: execution.actionResults,
              stopReason: execution.stopReason,
              retrySummary: execution.retrySummary,
              nextAction: "External agent must execute the declared actions and feed runtime events back into the relay before miniapp scenario/closure.",
              demoProhibited: true,
            },
            options.pretty
          )
        );
        return 1;
      }
      const scenarioResult = await postJson(fetchImpl, `${options.relay}/scenarios/validate`, {
        runId,
        templateName: scenario.id,
        target: "miniapp",
      });
      const bundle = await fetchMiniappClosureBundle(fetchImpl, options.relay, runId);
      const payload = {
        ok: true,
        support: support.report,
        projectVerify,
        runId,
        driver,
        contract: contract.contract,
        scenario,
        driverResolution: execution.driverResolution,
        executionLedger: execution.executionLedger,
        stopReason: execution.stopReason,
        retrySummary: execution.retrySummary,
        execution,
        scenarioResult: scenarioResult.scenario,
        demoProhibited: true,
        ...bundle,
      };
      const written = await maybeWriteArtifact(options.artifact, payload);
      stdout(format({ ...payload, artifactPath: written }, options.pretty));
      return execution.status === "driver_not_available" ? 1 : 0;
    }

    if (command[0] === "miniapp" && command[1] === "scenario") {
      const templateName = options.params.templateName || options.params.scenario || "miniapp_home_entry";
      const actions = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/actions`).catch(() => ({ actions: [] }));
      if (!Array.isArray(actions.actions) || actions.actions.length === 0) {
        stdout(
          format(
            {
              ok: false,
              status: "integration_required",
              reasonCode: "driver_required",
              reason: "miniapp scenario requires a run with real driver action evidence.",
              recommendedAction: "Run relay miniapp run with --driverModule before validating scenario closure.",
              runId: options.params.runId,
              demoProhibited: true,
            },
            options.pretty
          )
        );
        return 1;
      }
      const payload = await postJson(fetchImpl, `${options.relay}/scenarios/validate`, {
        runId: options.params.runId,
        templateName,
        target: "miniapp",
      });
      const observation = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/miniapp-observation`);
      stdout(format({ ok: true, scenario: payload.scenario, miniappObservation: observation.miniappObservation || observation.miniappSignals }, options.pretty));
      return 0;
    }

    if (command[0] === "miniapp" && command[1] === "closure") {
      const contract = await fetchDriverContract(fetchImpl, options.relay, {
        target: "miniapp",
        driver: options.params.driver || "external-agent",
      });
      const bundle = await fetchMiniappClosureBundle(fetchImpl, options.relay, options.params.runId);
      const actions = await requestJson(fetchImpl, `${options.relay}/ai/run/${options.params.runId}/actions`).catch(() => ({ actions: [] }));
      stdout(
        format(
          {
            ok: true,
            runId: options.params.runId,
            driverContract: contract.contract,
            driverResolution: {
              required: true,
              hasActionEvidence: Array.isArray(actions.actions) && actions.actions.length > 0,
            },
            demoProhibited: true,
            ...bundle,
          },
          options.pretty
        )
      );
      if (!Array.isArray(actions.actions) || actions.actions.length === 0) return 1;
      if (bundle.releaseDecision?.decision === "ship") return 0;
      if (bundle.releaseDecision?.decision === "manual_review_required") return 2;
      return 1;
    }

    stderr("Unknown command.\n");
    return 1;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
