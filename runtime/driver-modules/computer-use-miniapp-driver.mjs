import { readFile } from "node:fs/promises";
import path from "node:path";

function actionPlanForScenario(scenario) {
  if (Array.isArray(scenario?.actions) && scenario.actions.length > 0) {
    return scenario.actions;
  }
  const pagePath = scenario?.pagePath || scenario?.entry?.page || scenario?.entry?.route || "";
  return [
    pagePath
      ? { id: `${scenario?.id || "miniapp"}:enter`, type: "enter_page", pagePath, route: pagePath }
      : { id: `${scenario?.id || "miniapp"}:launch`, type: "launch", route: "/" },
  ];
}

function unavailable(input, reason) {
  return {
    status: "driver_not_available",
    reason,
    actionResults: actionPlanForScenario(input.scenario).map((action) => ({
      actionId: action.id,
      type: action.type,
      pagePath: action.pagePath || action.route || "",
      success: false,
      completionStatus: "bridge_required",
      reason,
    })),
  };
}

function normalizeEvent(event, action, ledger) {
  const route = event.route || action.pagePath || action.route || "";
  return {
    source: event.source || "miniapp",
    level: event.level || "info",
    message: event.message || `${action.type}:${action.id}`,
    phase: event.phase || "lifecycle",
    route,
    tags: Array.isArray(event.tags) ? event.tags : [],
    context: {
      ...(event.context || {}),
      computerUse: true,
      app: ledger.app || "WeChat DevTools",
      actionId: action.id,
    },
    network: event.network,
    requestId: event.requestId,
    errorKind: event.errorKind,
    stack: event.stack,
  };
}

function normalizeAction(entry, fallbackAction, ledger) {
  const actionId = String(entry.actionId || entry.id || fallbackAction?.id || "");
  const type = String(entry.type || fallbackAction?.type || "tap");
  const pagePath = String(entry.pagePath || fallbackAction?.pagePath || fallbackAction?.route || "");
  const emittedEvents = Array.isArray(entry.emittedEvents) ? entry.emittedEvents : [];
  const hasRuntimeEvidence = emittedEvents.length > 0;
  const success = Boolean(entry.success) && hasRuntimeEvidence;
  return {
    actionId,
    type,
    pagePath,
    success,
    completionStatus: success ? "executed" : entry.completionStatus || "failed",
    reason: success ? String(entry.reason || "computer_use_action_observed") : String(entry.reason || "computer_use_runtime_evidence_missing"),
    retries: Number(entry.retries || 0),
    timeoutMs: Number(entry.timeoutMs || ledger.timeoutMs || 0),
    emittedEvents: emittedEvents.map((event) => normalizeEvent(event, { id: actionId, type, pagePath }, ledger)),
  };
}

export async function executeMiniappScenario(input) {
  const ledgerPath = String(process.env.DEV_LOG_RELAY_COMPUTER_USE_LEDGER || "").trim();
  if (!ledgerPath) {
    return unavailable(input, "computer_use_ledger_required");
  }

  let ledger;
  try {
    const resolved = path.isAbsolute(ledgerPath) ? ledgerPath : path.resolve(input.projectRoot, ledgerPath);
    ledger = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    return unavailable(input, `computer_use_ledger_unreadable:${error instanceof Error ? error.message : String(error)}`);
  }

  const ledgerProjectRoot = String(ledger.targetProjectRoot || "").trim();
  if (ledgerProjectRoot && path.resolve(ledgerProjectRoot) !== path.resolve(input.projectRoot)) {
    return unavailable(input, "computer_use_ledger_target_project_mismatch");
  }
  if (input.scenario?.blackbox) {
    if (ledger.planId !== input.scenario.blackbox.planId || ledger.planNonce !== input.scenario.blackbox.planNonce) {
      return unavailable(input, "computer_use_ledger_plan_nonce_mismatch");
    }
  }

  const entries = Array.isArray(ledger.cases) ? ledger.cases : Array.isArray(ledger.actions) ? ledger.actions : Array.isArray(ledger) ? ledger : [];
  if (entries.length === 0) {
    return unavailable(input, "computer_use_ledger_empty");
  }

  const plan = actionPlanForScenario(input.scenario);
  return entries.map((entry, index) => {
    const fallback = plan.find((action) => action.id === entry.caseId || action.id === entry.actionId || action.id === entry.id) || plan[index];
    if (input.scenario?.blackbox) {
      const expectedNonce = input.scenario.blackbox.caseNonces?.[String(entry.caseId || entry.actionId || entry.id || "")];
      if (!expectedNonce || entry.caseNonce !== expectedNonce) {
        return {
          actionId: String(entry.caseId || entry.actionId || entry.id || fallback?.id || ""),
          type: String(fallback?.type || entry.type || "tap"),
          pagePath: String(fallback?.pagePath || entry.pagePath || ""),
          success: false,
          completionStatus: "failed",
          reason: "computer_use_ledger_case_nonce_mismatch",
          emittedEvents: [],
        };
      }
      if (!Array.isArray(entry.actionLedger) || entry.actionLedger.length === 0) {
        return {
          actionId: String(entry.caseId || entry.actionId || entry.id || fallback?.id || ""),
          type: String(fallback?.type || entry.type || "tap"),
          pagePath: String(fallback?.pagePath || entry.pagePath || ""),
          success: false,
          completionStatus: "failed",
          reason: "action_ledger_required",
          emittedEvents: [],
        };
      }
    }
    return normalizeAction({ ...entry, actionId: entry.actionId || entry.caseId }, fallback, ledger);
  });
}
