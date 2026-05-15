import path from "node:path";
import type {
  BlackboxActionTrace,
  BlackboxPlan,
  BlackboxRunReport,
  ComputerUseLedger,
  MiniappActionResult,
  RelayLogInput,
} from "../types.js";

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  reasonCode?: string;
  message?: string;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string" && String(record[key]).trim().length > 0;
}

function fail<T>(reasonCode: string, message: string): ValidationResult<T> {
  return { ok: false, reasonCode, message };
}

export function validateTargetProject(value: unknown, target: "web" | "miniapp" = "web"): ValidationResult<Record<string, unknown>> {
  const record = objectValue(value);
  if (!record) return fail("target_project_invalid", "targetProject must be an object.");
  if (!hasString(record, "workspaceRoot") || !hasString(record, "resolvedProjectRoot")) {
    return fail("target_project_invalid", "targetProject requires workspaceRoot and resolvedProjectRoot.");
  }
  if (target === "web" && !hasString(record, "targetUrl")) {
    return fail("target_project_invalid", "web targetProject requires targetUrl.");
  }
  return { ok: true, value: record };
}

export function validateBlackboxPlan(value: unknown): ValidationResult<BlackboxPlan> {
  const record = objectValue(value);
  if (!record) return fail("blackbox_plan_invalid", "BlackboxPlan must be an object.");
  if (!hasString(record, "planId") || !hasString(record, "planNonce")) {
    return fail("blackbox_plan_invalid", "BlackboxPlan requires planId and planNonce.");
  }
  if (record.target !== "web" && record.target !== "miniapp") {
    return fail("blackbox_plan_invalid", "BlackboxPlan target must be web or miniapp.");
  }
  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    return fail("blackbox_plan_invalid", "BlackboxPlan requires at least one case.");
  }
  for (const testCase of record.cases) {
    const item = objectValue(testCase);
    if (!item || !hasString(item, "id") || !hasString(item, "caseNonce") || !Array.isArray(item.steps) || !Array.isArray(item.visibleAssertions)) {
      return fail("blackbox_plan_invalid", "Every blackbox case requires id, caseNonce, steps, and visibleAssertions.");
    }
  }
  return { ok: true, value: value as BlackboxPlan };
}

export function validateBlackboxRunReport(value: unknown): ValidationResult<BlackboxRunReport> {
  const record = objectValue(value);
  if (!record) return fail("blackbox_report_invalid", "BlackboxRunReport must be an object.");
  if (!hasString(record, "runId") || !hasString(record, "planId")) {
    return fail("blackbox_report_invalid", "BlackboxRunReport requires runId and planId.");
  }
  if (record.target !== "web" && record.target !== "miniapp") {
    return fail("blackbox_report_invalid", "BlackboxRunReport target must be web or miniapp.");
  }
  if (!Array.isArray(record.cases)) {
    return fail("blackbox_report_invalid", "BlackboxRunReport requires cases.");
  }
  for (const testCase of record.cases) {
    const item = objectValue(testCase);
    if (!item || !hasString(item, "caseId") || !hasString(item, "userGoal") || !Array.isArray(item.visibleEvidence)) {
      return fail("blackbox_report_invalid", "Every report case requires caseId, userGoal, and visibleEvidence.");
    }
    if (item.status === "passed" && item.visibleEvidence.length === 0) {
      return fail("blackbox_report_invalid", "Passed blackbox cases require visibleEvidence.");
    }
  }
  return { ok: true, value: value as BlackboxRunReport };
}

export function validateBlackboxActionTrace(value: unknown): ValidationResult<BlackboxActionTrace> {
  const record = objectValue(value);
  if (!record) return fail("blackbox_trace_invalid", "BlackboxActionTrace must be an object.");
  if (!hasString(record, "runId") || !hasString(record, "planId") || !hasString(record, "caseId") || !hasString(record, "generatedAt")) {
    return fail("blackbox_trace_invalid", "BlackboxActionTrace requires runId, planId, caseId, and generatedAt.");
  }
  if (record.status !== "passed" && record.status !== "failed" && record.status !== "skipped" && record.status !== "manual_review_required") {
    return fail("blackbox_trace_invalid", "BlackboxActionTrace status must be passed, failed, skipped, or manual_review_required.");
  }
  if (!Array.isArray(record.actions) || record.actions.length === 0) {
    return fail("blackbox_trace_invalid", "BlackboxActionTrace requires at least one action.");
  }
  for (const action of record.actions) {
    const item = objectValue(action);
    if (!item || !hasString(item, "action")) {
      return fail("blackbox_trace_invalid", "Every trace action requires an action name.");
    }
  }
  if (!Array.isArray(record.assertionResults)) {
    return fail("blackbox_trace_invalid", "BlackboxActionTrace requires assertionResults.");
  }
  for (const assertion of record.assertionResults) {
    const item = objectValue(assertion);
    if (!item || !hasString(item, "id") || typeof item.passed !== "boolean") {
      return fail("blackbox_trace_invalid", "Every trace assertion requires id and passed.");
    }
  }
  return { ok: true, value: value as BlackboxActionTrace };
}

export function validateComputerUseLedger(value: unknown, plan: BlackboxPlan, targetProject: Record<string, unknown>): ValidationResult<ComputerUseLedger> {
  const record = objectValue(value);
  if (!record) return fail("computer_use_ledger_invalid", "Computer Use ledger must be an object.");
  if (record.driver !== "computer-use") {
    return fail("computer_use_ledger_invalid", "Computer Use ledger requires driver=computer-use.");
  }
  if (record.target !== plan.target) {
    return fail("computer_use_ledger_invalid", "Computer Use ledger target does not match the plan.");
  }
  if (record.planId !== plan.planId || record.planNonce !== plan.planNonce) {
    return fail("computer_use_ledger_invalid", "Computer Use ledger planId or planNonce does not match.");
  }
  const ledgerRoot = String(record.targetProjectRoot || record.workspaceRoot || "");
  const expectedRoot = String(targetProject.workspaceRoot || "");
  if (!ledgerRoot || !expectedRoot || path.resolve(ledgerRoot) !== path.resolve(expectedRoot)) {
    return fail("computer_use_ledger_target_project_mismatch", "Computer Use ledger target project root does not match.");
  }
  if (plan.target === "web") {
    const ledgerUrl = String(record.targetUrl || "");
    const expectedUrl = String(targetProject.targetUrl || "");
    if (!ledgerUrl || ledgerUrl !== expectedUrl) {
      return fail("computer_use_ledger_target_url_mismatch", "Computer Use ledger target URL does not match.");
    }
  }
  const cases = Array.isArray(record.cases) ? record.cases : Array.isArray(record.actions) ? record.actions : [];
  if (cases.length === 0) return fail("computer_use_ledger_invalid", "Computer Use ledger requires cases.");
  const caseNonceById = new Map(plan.cases.map((testCase) => [testCase.id, testCase.caseNonce || ""]));
  const coveredCases = new Set<string>();
  for (const entry of cases) {
    const item = objectValue(entry);
    if (!item || !hasString(item, "caseId")) {
      return fail("computer_use_ledger_invalid", "Every Computer Use ledger case requires caseId.");
    }
    const expectedNonce = caseNonceById.get(String(item.caseId));
    if (!expectedNonce || item.caseNonce !== expectedNonce) {
      return fail("computer_use_ledger_invalid", `Computer Use ledger case nonce mismatch for ${String(item.caseId)}.`);
    }
    coveredCases.add(String(item.caseId));
    const visibleEvidence = Array.isArray(item.visibleEvidence) ? item.visibleEvidence : Array.isArray(item.visible_evidence) ? item.visible_evidence : [];
    if (visibleEvidence.length === 0) {
      return fail("visible_evidence_required", `Computer Use ledger case ${String(item.caseId)} requires visibleEvidence.`);
    }
    if (!Array.isArray(item.actionLedger) || item.actionLedger.length === 0) {
      return fail("action_ledger_required", `Computer Use ledger case ${String(item.caseId)} requires actionLedger.`);
    }
  }
  const missingCases = plan.cases.map((testCase) => testCase.id).filter((caseId) => !coveredCases.has(caseId));
  if (missingCases.length > 0) {
    return fail("computer_use_ledger_invalid", `Computer Use ledger is missing plan cases: ${missingCases.join(", ")}.`);
  }
  return { ok: true, value: { ...(record as unknown as ComputerUseLedger), cases: cases as ComputerUseLedger["cases"] } };
}

export function validateMiniappActionResults(value: unknown): ValidationResult<MiniappActionResult[]> {
  if (!Array.isArray(value)) return fail("driver_result_invalid", "Miniapp driver result must be an array.");
  for (const action of value) {
    const item = objectValue(action);
    if (!item || !hasString(item, "actionId") || !hasString(item, "type")) {
      return fail("driver_result_invalid", "Every Miniapp driver action requires actionId and type.");
    }
    if (item.success === true) {
      if (!Array.isArray(item.emittedEvents) || item.emittedEvents.length === 0) {
        return fail("driver_result_invalid", "Successful Miniapp driver actions require emittedEvents.");
      }
      if (visibleEvidenceFromEvents(item.emittedEvents as RelayLogInput[]).length === 0) {
        return fail("visible_evidence_required", "Successful Miniapp driver actions require explicit visible evidence.");
      }
    }
  }
  return { ok: true, value: value as MiniappActionResult[] };
}

export function visibleEvidenceFromEvents(events: RelayLogInput[] | undefined): string[] {
  if (!Array.isArray(events)) return [];
  const evidence: string[] = [];
  for (const event of events) {
    const context = event.context || {};
    if (Array.isArray(context.visibleEvidence)) evidence.push(...context.visibleEvidence.map(String));
    if (typeof context.visibleText === "string" && context.visibleText.trim()) evidence.push(context.visibleText.trim());
    if (typeof context.screenshotDescription === "string" && isMeaningfulScreenshotDescription(context.screenshotDescription)) {
      evidence.push(context.screenshotDescription.trim());
    }
  }
  return Array.from(new Set(evidence.filter(Boolean)));
}

function isMeaningfulScreenshotDescription(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/^screenshot captured\b/i.test(text)) return false;
  if (/^miniapp screenshot captured\b/i.test(text)) return false;
  if (/^screen captured\b/i.test(text)) return false;
  return text.length >= 8;
}
