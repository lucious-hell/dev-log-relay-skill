import type { BlackboxRunReport, GateDecision, HarnessGate, RelayFailure } from "../types.js";

export function relayFailure(input: {
  reasonCode: string;
  family?: RelayFailure["family"];
  severity?: RelayFailure["severity"];
  userMessage: string;
  recommendedAction: string;
  retryable?: boolean;
  evidenceRefs?: RelayFailure["evidenceRefs"];
}): RelayFailure {
  return {
    reasonCode: input.reasonCode,
    family: input.family || "unknown",
    severity: input.severity || "blocking",
    userMessage: input.userMessage,
    recommendedAction: input.recommendedAction,
    retryable: input.retryable !== false,
    evidenceRefs: input.evidenceRefs,
  };
}

export function evaluateBlackboxGate(input: {
  blockingPassedCases: string[];
  blockingFailedCases: string[];
  manualReviewCases: string[];
  runtimeBlockingItems: string[];
}): NonNullable<BlackboxRunReport["blackboxGate"]> {
  const runtimeBlockingItems = Array.from(new Set([
    ...input.runtimeBlockingItems,
    ...input.manualReviewCases.map((caseId) => `blackbox:${caseId}:manual_review_required`),
  ]));
  const passed =
    input.blockingPassedCases.length > 0 &&
    input.blockingFailedCases.length === 0 &&
    input.manualReviewCases.length === 0 &&
    input.runtimeBlockingItems.length === 0;
  return {
    passed,
    reason:
      input.blockingPassedCases.length === 0
        ? "blackbox_blocking_pass_required"
        : input.blockingFailedCases.length > 0
          ? "blackbox_case_failed"
          : input.manualReviewCases.length > 0
            ? "locator_repair_manual_review_required"
            : input.runtimeBlockingItems.length > 0
              ? "runtime_blocking_failure"
              : "blackbox_gate_passed",
    blockingPassedCases: input.blockingPassedCases,
    blockingFailedCases: input.blockingFailedCases,
    runtimeBlockingItems,
  };
}

export function evaluateHarnessGate(checks: HarnessGate["checks"], failures: {
  failedCases: string[];
  manualReviewCases: string[];
  runtimeBlockingItems: string[];
}): HarnessGate {
  const blockingReasons = [
    ...(checks.targetProjectResolved ? [] : ["harness_target_unresolved"]),
    ...(checks.targetMatchesBlackbox && checks.targetProjectMatchesBlackbox ? [] : ["harness_target_mismatch"]),
    ...(checks.environmentStarted ? [] : ["harness_environment_start_failed"]),
    ...(checks.driverAvailable ? [] : ["harness_driver_unavailable"]),
    ...(checks.blackboxBlockingPass ? [] : ["harness_blackbox_required"]),
    ...(checks.noBlackboxFailures ? [] : failures.failedCases.map((caseId) => `blackbox:${caseId}:failed`)),
    ...(checks.noManualReview ? [] : failures.manualReviewCases.map((caseId) => `blackbox:${caseId}:manual_review_required`)),
    ...(checks.noBlockingRuntimeFailure ? [] : failures.runtimeBlockingItems),
    ...(checks.evidenceRefsValid ? [] : ["harness_evidence_invalid"]),
    ...(checks.regressionSeededWhenFailed ? [] : ["harness_regression_seed_failed"]),
    ...(checks.miniappProfileIsolated ? [] : ["miniapp_profile_isolation_unverified"]),
  ];
  return {
    status: blockingReasons.length === 0 ? "pass" : "hold",
    reasonCode: blockingReasons[0] || "harness_gate_passed",
    blockingReasons,
    checks,
  };
}

export function releaseFacingGate(gate: HarnessGate): GateDecision {
  return {
    status: gate.status,
    reasonCode: gate.reasonCode,
    blockingReasons: gate.blockingReasons,
    checks: gate.checks,
  };
}
