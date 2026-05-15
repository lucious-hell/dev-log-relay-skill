import path from "node:path";
import { pathToFileURL } from "node:url";
import type { MiniappActionInput, MiniappActionResult, MiniappDriverType, ScenarioSpec } from "../types.js";
import { validateMiniappActionResults } from "../core/validation.js";
import { executeBuiltinDevtoolsAutomator } from "./builtin-devtools-automator-driver.js";

export interface ExecuteMiniappDriverInput {
  driver: MiniappDriverType;
  scenario: ScenarioSpec;
  relay: string;
  runId: string;
  projectRoot: string;
  driverModule?: string;
  cliPath?: string;
  servicePort?: string;
  projectPath?: string;
  profileDir?: string;
}

export interface ExecuteMiniappDriverOutput {
  status: "executed" | "driver_not_available" | "bridge_required";
  actionResults: MiniappActionResult[];
  reason: string;
}

interface MiniappDriverModule {
  executeMiniappScenario?: (input: ExecuteMiniappDriverInput) => Promise<MiniappActionResult[] | ExecuteMiniappDriverOutput> | MiniappActionResult[] | ExecuteMiniappDriverOutput;
}

function defaultActionsForScenario(spec: ScenarioSpec): MiniappActionInput[] {
  if (spec.actions && spec.actions.length > 0) {
    return spec.actions;
  }
  const pagePath = spec.pagePath || spec.entry.page || spec.entry.route || "";
  const actions: MiniappActionInput[] = [];
  if (pagePath) {
    actions.push({ id: `${spec.id}:enter`, type: "enter_page", pagePath, route: pagePath });
  } else {
    actions.push({ id: `${spec.id}:launch`, type: "launch", route: "/" });
  }
  if (spec.id.includes("refresh")) {
    actions.push({ id: `${spec.id}:refresh`, type: "pull_down_refresh", pagePath });
  }
  if (spec.id.includes("retry")) {
    actions.push({ id: `${spec.id}:retry`, type: "retry", pagePath });
  }
  if (spec.id.includes("share")) {
    actions.push({ id: `${spec.id}:share`, type: "share_entry", pagePath });
  }
  return actions;
}

async function loadDriverModule(driverModule?: string): Promise<MiniappDriverModule | null> {
  const candidate = String(driverModule || process.env.DEV_LOG_RELAY_MINIAPP_DRIVER_MODULE || "").trim();
  if (!candidate) return null;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
  const mod = (await import(pathToFileURL(resolved).href)) as MiniappDriverModule;
  return mod;
}

export async function executeMiniappReferenceDriver(input: ExecuteMiniappDriverInput): Promise<ExecuteMiniappDriverOutput> {
  if (input.driver === "external-agent") {
    return {
      status: "bridge_required",
      actionResults: defaultActionsForScenario(input.scenario).map((action) => ({
        actionId: action.id,
        type: action.type,
        pagePath: action.pagePath,
        success: false,
        reason: "external_agent_must_execute_and_feed_back_runtime_events",
      })),
      reason: "external_agent_bridge_required",
    };
  }

  const injectedModule = await loadDriverModule(input.driverModule);
  if (injectedModule?.executeMiniappScenario) {
    const results = await injectedModule.executeMiniappScenario(input);
    if (!Array.isArray(results)) {
      const validation = validateMiniappActionResults(results.actionResults);
      if (!validation.ok) {
        return {
          status: "driver_not_available",
          actionResults: defaultActionsForScenario(input.scenario).map((action) => ({
            actionId: action.id,
            type: action.type,
            pagePath: action.pagePath,
            success: false,
            reason: validation.reasonCode || "driver_result_invalid",
          })),
          reason: validation.reasonCode || "driver_result_invalid",
        };
      }
      return results;
    }
    const validation = validateMiniappActionResults(results);
    if (!validation.ok) {
      return {
        status: "driver_not_available",
        actionResults: defaultActionsForScenario(input.scenario).map((action) => ({
          actionId: action.id,
          type: action.type,
          pagePath: action.pagePath,
          success: false,
          reason: validation.reasonCode || "driver_result_invalid",
        })),
        reason: validation.reasonCode || "driver_result_invalid",
      };
    }
    return {
      status: "executed",
      actionResults: results,
      reason: "driver_module_executed",
    };
  }

  if (input.driver === "devtools-automator") {
    const results = await executeBuiltinDevtoolsAutomator(input);
    const validation = validateMiniappActionResults(results.actionResults);
    if (!validation.ok && results.status === "executed") {
      return {
        status: "driver_not_available",
        actionResults: defaultActionsForScenario(input.scenario).map((action) => ({
          actionId: action.id,
          type: action.type,
          pagePath: action.pagePath,
          success: false,
          reason: validation.reasonCode || "driver_result_invalid",
        })),
        reason: validation.reasonCode || "driver_result_invalid",
      };
    }
    return results;
  }

  return {
    status: "driver_not_available",
    actionResults: defaultActionsForScenario(input.scenario).map((action) => ({
      actionId: action.id,
      type: action.type,
      pagePath: action.pagePath,
      success: false,
      reason: "generic_miniapp_driver_not_configured",
    })),
    reason: "generic_miniapp_driver_not_configured",
  };
}
