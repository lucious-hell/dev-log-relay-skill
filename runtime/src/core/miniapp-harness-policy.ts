import type { BlackboxRunReport, HarnessVerificationReport } from "../types.js";

export interface MiniappHarnessCommandOptions {
  relay?: string;
  pretty?: boolean;
  params?: Record<string, string | undefined>;
}

export function buildMiniappRetryCommand(options: MiniappHarnessCommandOptions): string {
  const params = options.params || {};
  const args = ["relay", "harness", "verify"];
  const pushPair = (key: string, value?: string) => {
    const trimmed = String(value || "").trim();
    if (trimmed) args.push(`--${key}`, trimmed);
  };
  pushPair("relay", options.relay);
  pushPair("target", "miniapp");
  pushPair("driver", params.driver || "devtools-automator");
  for (const key of ["driverModule", "ledger", "servicePort", "cliPath", "projectPath", "profileDir", "sidecarPort", "planId", "baselineRunId"]) {
    pushPair(key, params[key]);
  }
  for (const goal of String(params.goal || "").split("\n").map((item) => item.trim()).filter(Boolean)) {
    pushPair("goal", goal);
  }
  if (params.noAutoPrepare === "true") args.push("--noAutoPrepare");
  if (options.pretty) args.push("--pretty");
  return args.map(shellQuote).join(" ");
}

export function miniappReasonCodesForReport(input: {
  bootstrapReasonCodes: string[];
  driverReasonCodes: string[];
  report?: BlackboxRunReport;
}): string[] {
  const reasonCodes = [...input.bootstrapReasonCodes, ...input.driverReasonCodes];
  const report = input.report;
  if (!report || report.failed === 0) return reasonCodes;
  const haystack = report.cases
    .filter((testCase) => testCase.status === "failed")
    .flatMap((testCase) => [
      testCase.failureReason,
      ...testCase.visibleEvidence,
      ...testCase.runtimeEvidence,
    ])
    .join(" ")
    .toLowerCase();
  if (/(login|log in|signin|sign in|auth|authorize|permission|扫码|登录|授权|未登录|请先登录|手机号|session expired)/i.test(haystack)) {
    reasonCodes.push("business_auth_required");
  } else if (/visible_evidence_required|visible evidence|blank|empty|screenshot/i.test(haystack)) {
    reasonCodes.push("visible_evidence_required");
  } else if (/driver|automator|devtools|element_not_found|timeout|service_port/i.test(haystack)) {
    reasonCodes.push("builtin_miniapp_driver_unavailable");
  }
  return reasonCodes;
}

export function miniappUserActionRequest(input: {
  reasonCodes: string[];
  options: MiniappHarnessCommandOptions;
  servicePort?: string;
}): NonNullable<NonNullable<HarnessVerificationReport["forExecutingAI"]["userActionRequest"]>> {
  const reasons = new Set(input.reasonCodes);
  const servicePort = String(input.servicePort || input.options.params?.servicePort || process.env.DEV_LOG_RELAY_MINIAPP_SERVICE_PORT || "9420");
  const retryCommand = buildMiniappRetryCommand(input.options);
  if (reasons.has("miniapp_profile_write_failed") || reasons.has("macos_permission_required")) {
    return {
      required: true,
      reasonCode: "macos_permission_required",
      minimalUserSteps: ["Allow Codex or the local relay helper to access the WeChat DevTools profile when macOS prompts.", "Return to the executing AI after the permission prompt is accepted."],
      afterUserDoneCommand: retryCommand,
      doNotAskUserIf: ["The failure is only miniprogram-automator missing.", "The sidecar can still start and report servicePortReachable=true."],
    };
  }
  if (reasons.has("miniapp_cli_not_found")) {
    return {
      required: true,
      reasonCode: "devtools_first_run_required",
      minimalUserSteps: ["Install WeChat Developer Tools or enable its command line tool once.", "Open WeChat Developer Tools once and complete first-run prompts."],
      afterUserDoneCommand: retryCommand,
      doNotAskUserIf: ["A reachable service port is already available.", "An external driverModule or valid Computer Use ledger is provided."],
    };
  }
  if (reasons.has("miniapp_service_port_unreachable") || reasons.has("devtools_service_port_unreachable") || reasons.has("miniapp_service_port_required")) {
    return {
      required: true,
      reasonCode: "devtools_first_run_required",
      minimalUserSteps: [`In WeChat Developer Tools, open Settings -> Security Settings and enable Service Port ${servicePort}.`, "Leave WeChat Developer Tools running, then tell the executing AI to retry."],
      afterUserDoneCommand: retryCommand,
      doNotAskUserIf: ["relay miniapp sidecar start can still open DevTools and make servicePortReachable=true.", "The failure is only a target project code issue."],
    };
  }
  if (reasons.has("business_auth_required")) {
    return {
      required: true,
      reasonCode: "business_auth_required",
      minimalUserSteps: ["Complete the target miniapp's business login, scan, or authorization prompt once in the controlled DevTools instance.", "Return to the executing AI after the expected page is visible."],
      afterUserDoneCommand: retryCommand,
      doNotAskUserIf: ["The app can be tested with a non-authenticated blackbox goal.", "A valid auth fixture or test account is already configured."],
    };
  }
  return {
    required: false,
    reasonCode: reasons.has("builtin_miniapp_driver_unavailable") ? "builtin_miniapp_driver_unavailable" : "none",
    minimalUserSteps: [],
    afterUserDoneCommand: retryCommand,
    doNotAskUserIf: ["The executing AI can continue auto-preparing the runtime or fix project integration without asking the user."],
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
