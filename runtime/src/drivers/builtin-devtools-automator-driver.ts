import path from "node:path";
import { pathToFileURL } from "node:url";
import type { MiniappActionInput, MiniappActionResult, MiniappDriverEnvironment, RelayLogInput, ScenarioSpec } from "../types.js";
import type { ExecuteMiniappDriverInput, ExecuteMiniappDriverOutput } from "./miniapp-reference-driver.js";

type AnyRecord = Record<string, any>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePagePath(value?: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function scenarioActions(spec: ScenarioSpec): MiniappActionInput[] {
  if (spec.actions && spec.actions.length > 0) return spec.actions;
  const pagePath = normalizePagePath(spec.pagePath || spec.entry.page || spec.entry.route || "");
  return [{ id: `${spec.id}:enter`, type: pagePath ? "enter_page" : "launch", pagePath, route: pagePath || "/" }];
}

async function callMaybe(target: AnyRecord | null | undefined, names: string[], ...args: any[]): Promise<any> {
  if (!target) throw new Error("target_unavailable");
  let lastError: unknown;
  for (const name of names) {
    if (typeof target[name] !== "function") continue;
    try {
      return await target[name](...args);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(`${names.join("|")}_unavailable`);
}

async function optionalCall(target: AnyRecord | null | undefined, names: string[], ...args: any[]): Promise<any> {
  try {
    return await callMaybe(target, names, ...args);
  } catch {
    return undefined;
  }
}

async function loadAutomator(): Promise<AnyRecord> {
  const modulePath = String(process.env.DEV_LOG_RELAY_MINIAPP_AUTOMATOR_MODULE || "").trim();
  if (modulePath) {
    const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath);
    return await import(pathToFileURL(resolved).href) as AnyRecord;
  }
  return await new Function("return import('miniprogram-automator')")() as AnyRecord;
}

async function connectAutomator(automator: AnyRecord, env: MiniappDriverEnvironment, timeoutMs: number): Promise<{ miniProgram: AnyRecord; mode: string }> {
  const servicePort = String(env.servicePort || process.env.DEV_LOG_RELAY_MINIAPP_SERVICE_PORT || "9420");
  const endpoints = [`ws://127.0.0.1:${servicePort}`, `ws://localhost:${servicePort}`];
  let lastError: unknown;
  if (typeof automator.connect === "function") {
    for (const wsEndpoint of endpoints) {
      try {
        return { miniProgram: await automator.connect({ wsEndpoint, timeout: timeoutMs }), mode: "connect" };
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (typeof automator.launch === "function") {
    try {
      return {
        miniProgram: await automator.launch({
          projectPath: env.projectPath,
          cliPath: env.cliPath,
          port: Number(servicePort),
          timeout: timeoutMs,
          profileDir: env.profileDir,
          userDataDir: env.profileDir,
          env: env.profileDir ? { HOME: env.profileDir, USERPROFILE: env.profileDir } : undefined,
        }),
        mode: "launch",
      };
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError || "miniprogram_automator_unreachable");
  throw new Error(message);
}

async function currentPage(miniProgram: AnyRecord): Promise<AnyRecord | null> {
  const page = await optionalCall(miniProgram, ["currentPage"]);
  if (page) return page;
  const pages = await optionalCall(miniProgram, ["pageStack", "getPageStack"]);
  return Array.isArray(pages) && pages.length > 0 ? pages[pages.length - 1] : null;
}

function pageRoute(page: AnyRecord | null, fallback: string): string {
  if (!page) return fallback;
  const route = page.path || page.route || page.pagePath || "";
  return String(route || fallback);
}

async function elementText(element: AnyRecord): Promise<string> {
  const values = await Promise.all([
    optionalCall(element, ["text"]),
    optionalCall(element, ["attribute", "attr"], "aria-label"),
    optionalCall(element, ["attribute", "attr"], "placeholder"),
    optionalCall(element, ["attribute", "attr"], "value"),
  ]);
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

async function visibleText(page: AnyRecord | null): Promise<string[]> {
  if (!page) return [];
  const selectors = ["text", "button", "input", "textarea", "navigator", "view"];
  const texts: string[] = [];
  for (const selector of selectors) {
    const elements = await optionalCall(page, ["$$"], selector);
    if (!Array.isArray(elements)) continue;
    for (const element of elements.slice(0, 40)) {
      const text = await elementText(element);
      if (text) texts.push(text);
    }
  }
  return Array.from(new Set(texts)).slice(0, 30);
}

async function screenshotDescription(miniProgram: AnyRecord, page: AnyRecord | null): Promise<string> {
  const result = await optionalCall(page, ["screenshot"]) || await optionalCall(miniProgram, ["screenshot"]);
  if (!result) return "";
  if (typeof result === "string") return `screenshot captured: ${result}`;
  if (result?.byteLength || result?.length) return "screenshot captured from Miniapp DevTools";
  return "screenshot captured from Miniapp DevTools";
}

async function findElement(page: AnyRecord | null, selector?: string): Promise<AnyRecord | null> {
  const value = String(selector || "").trim();
  if (!page || !value) return null;
  return await optionalCall(page, ["$"], value) || null;
}

async function performAction(miniProgram: AnyRecord, action: MiniappActionInput): Promise<{ route: string; notes: string[] }> {
  const pagePath = normalizePagePath(action.pagePath || action.route || "");
  const notes: string[] = [];
  if (action.type === "launch" || action.type === "enter_page") {
    if (pagePath) {
      await callMaybe(miniProgram, ["reLaunch", "navigateTo"], { url: pagePath });
    }
    return { route: pagePath || "/", notes };
  }
  if (action.type === "switch_tab") {
    await callMaybe(miniProgram, ["switchTab"], { url: pagePath });
    return { route: pagePath || "/", notes };
  }
  if (action.type === "navigate_back") {
    await callMaybe(miniProgram, ["navigateBack"], {});
    return { route: pagePath || "", notes };
  }
  const page = await currentPage(miniProgram);
  if (action.type === "tap") {
    const element = await findElement(page, action.selector || String(action.metadata?.selector || ""));
    if (!element) throw new Error("miniapp_element_not_found");
    await callMaybe(element, ["tap"]);
    return { route: pageRoute(page, pagePath), notes };
  }
  if (action.type === "input") {
    const element = await findElement(page, action.selector || String(action.metadata?.selector || ""));
    if (!element) throw new Error("miniapp_element_not_found");
    await callMaybe(element, ["input", "type"], String(action.value || ""));
    return { route: pageRoute(page, pagePath), notes };
  }
  if (action.type === "pull_down_refresh") {
    await optionalCall(page, ["callMethod"], "onPullDownRefresh");
    notes.push("pull_down_refresh_requested");
    return { route: pageRoute(page, pagePath), notes };
  }
  if (action.type === "retry") {
    await sleep(300);
    notes.push("retry_wait_completed");
    return { route: pageRoute(page, pagePath), notes };
  }
  if (action.type === "share_entry") {
    notes.push("share_entry_observed_without_mutating");
    return { route: pageRoute(page, pagePath), notes };
  }
  return { route: pageRoute(page, pagePath), notes };
}

function eventsForAction(input: {
  action: MiniappActionInput;
  route: string;
  visible: string[];
  screenshot: string;
  notes: string[];
  mode: string;
}): RelayLogInput[] {
  const visibleEvidence = input.visible;
  return [
    {
      source: "miniapp",
      level: "info",
      message: `Miniapp automator ${input.action.type} ${input.route || ""}`.trim(),
      phase: "navigation",
      route: input.route,
      tags: ["route_transition", "devtools_automator"],
      context: {
        destinationRoute: input.route,
        pageStackRoutes: input.route ? [input.route] : [],
        automatorMode: input.mode,
        actionId: input.action.id,
        notes: input.notes,
      },
    },
    {
      source: "miniapp",
      level: "info",
      message: `Miniapp automator action boundary ${input.action.id}`,
      phase: "lifecycle",
      route: input.route,
      tags: ["action_boundary", "devtools_automator"],
      context: { actionId: input.action.id, actionType: input.action.type },
    },
    {
      source: "miniapp",
      level: "info",
      message: "Miniapp automator observed page readiness",
      phase: "network",
      route: input.route,
      requestId: `automator-${input.action.id}`,
      tags: ["devtools_automator", "page_ready"],
      network: { url: input.route || "/", method: "GET", stage: "success", ok: true },
      context: { actionId: input.action.id, actionType: input.action.type, observedBy: "miniprogram-automator" },
    },
    {
      source: "miniapp",
      level: "info",
      message: "Miniapp automator visible state signature",
      phase: "lifecycle",
      route: input.route,
      tags: ["setData", "state_update", "state_signature", "devtools_automator"],
      context: {
        actionId: input.action.id,
        actionType: input.action.type,
        keys: input.visible.length > 0 ? ["visibleText"] : [],
        stateSignature: visibleEvidence.join("|").slice(0, 200),
        visibleEvidence,
        visibleText: input.visible.join(" ").slice(0, 500),
        screenshotDescription: input.screenshot,
      },
    },
    {
      source: "miniapp",
      level: "info",
      message: visibleEvidence.length > 0 ? `Visible UI: ${visibleEvidence.join(" ").slice(0, 180)}` : "Visible UI evidence missing",
      phase: "render",
      route: input.route,
      tags: visibleEvidence.length > 0 ? ["visible_evidence", "render_complete"] : ["visible_evidence_missing"],
      context: {
        actionId: input.action.id,
        visibleEvidence,
        visibleText: input.visible.join(" ").slice(0, 500),
        screenshotDescription: input.screenshot,
      },
    },
  ];
}

function failedResult(action: MiniappActionInput, reason: string): MiniappActionResult {
  return {
    actionId: action.id,
    type: action.type,
    pagePath: action.pagePath || action.route,
    success: false,
    reason,
    completionStatus: reason.includes("timeout") ? "timeout" : "failed",
    emittedEvents: [
      {
        source: "miniapp",
        level: "warn",
        message: `Miniapp automator action failed: ${reason}`,
        phase: "render",
        route: action.pagePath || action.route || "",
        tags: ["devtools_automator", "driver_failure"],
        context: { actionId: action.id, actionType: action.type, reason },
      },
    ],
  };
}

export async function executeBuiltinDevtoolsAutomator(input: ExecuteMiniappDriverInput): Promise<ExecuteMiniappDriverOutput> {
  const timeoutMs = Number(input.scenario.retryPolicy?.timeoutMs || 5000);
  const actions = scenarioActions(input.scenario);
  let connected: { miniProgram: AnyRecord; mode: string };
  try {
    const automator = await loadAutomator();
    connected = await connectAutomator(automator, {
      cliPath: input.cliPath,
      servicePort: input.servicePort,
      projectPath: input.projectPath || input.projectRoot,
      profileDir: input.profileDir,
    }, timeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "driver_not_available",
      actionResults: actions.map((action) => failedResult(action, reason.includes("Cannot find") ? "builtin_miniapp_driver_unavailable" : `devtools_service_port_unreachable:${reason}`)),
      reason: reason.includes("Cannot find") ? "builtin_miniapp_driver_unavailable" : "devtools_service_port_unreachable",
    };
  }

  const results: MiniappActionResult[] = [];
  for (const action of actions) {
    try {
      const performed = await performAction(connected.miniProgram, action);
      await sleep(250);
      const page = await currentPage(connected.miniProgram);
      const visible = await visibleText(page);
      const screenshot = await screenshotDescription(connected.miniProgram, page);
      const route = pageRoute(page, performed.route);
      const emittedEvents = eventsForAction({ action, route, visible, screenshot, notes: performed.notes, mode: connected.mode });
      const hasVisibleEvidence = visible.length > 0;
      results.push({
        actionId: action.id,
        type: action.type,
        pagePath: route || action.pagePath || action.route,
        success: hasVisibleEvidence,
        reason: hasVisibleEvidence ? "builtin_devtools_automator_executed" : "visible_evidence_required",
        completionStatus: hasVisibleEvidence ? "executed" : "failed",
        timeoutMs,
        emittedEvents,
      });
    } catch (error) {
      results.push(failedResult(action, error instanceof Error ? error.message : String(error)));
    }
  }
  await optionalCall(connected.miniProgram, ["disconnect"]);
  return {
    status: results.every((item) => item.success) ? "executed" : "driver_not_available",
    actionResults: results,
    reason: results.every((item) => item.success) ? "builtin_devtools_automator_executed" : "builtin_devtools_automator_action_failed",
  };
}
