import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createMiniappRelay } from "./adapters/miniapp.js";
import { MiniappExecutionCoordinator } from "./core/miniapp-execution-coordinator.js";

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
    if (token.startsWith("--")) {
      options.params[token.slice(2)] = argv[index + 1] || "";
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
    throw new Error(json.message || `Request failed: ${response.status}`);
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

async function runExampleProcess(spawnImpl: typeof spawn, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    if ("stderr" in child && child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `example process exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function runExampleProcessWithOutput(spawnImpl: typeof spawn, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawnImpl(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if ("stdout" in child && child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
    }
    if ("stderr" in child && child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `example process exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function parseCsv(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function runWebScenario(
  fetchImpl: typeof fetch,
  spawnImpl: typeof spawn,
  relay: string,
  runId: string,
  mode: "baseline" | "broken" | "fixed",
  baselineRunId?: string
) {
  const runnerPath = path.join(process.cwd(), "examples", "web-playwright", "runner.mjs");
  const runnerArgs = [runnerPath, "--relay", relay, "--runId", runId, "--mode", mode];
  if (baselineRunId) {
    runnerArgs.push("--baselineRunId", baselineRunId);
  }
  const exampleOutput = await runExampleProcessWithOutput(spawnImpl, runnerArgs);
  const exampleEvidence = exampleOutput.stdout.trim() ? JSON.parse(exampleOutput.stdout) : null;
  const [summary, collection, diagnosis, closure, integrity, scenario, baseline, report] = await Promise.all([
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/summary`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/collection`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/diagnosis`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/closure`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/integrity`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/scenario`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/baseline`),
    requestJson(fetchImpl, `${relay}/ai/run/${runId}/report`),
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
    scenarioDiff: scenarioDiff?.changed || [],
    stateDiff: stateDiff?.changed || [],
    exampleEvidence,
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

async function createMiniappRun(
  fetchImpl: typeof fetch,
  relay: string,
  label: string,
  driver: string,
  scenarioId: string
) {
  return postJson(fetchImpl, `${relay}/runs/start`, {
    label,
    target: "miniapp",
    metadata: {
      projectRoot: resolveWorkspaceRoot(),
      driver,
      scenarioId,
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
  driverModule?: string
) {
  const coordinator = new MiniappExecutionCoordinator();
  const execution = await coordinator.execute({
    driver: (driver || "external-agent") as any,
    scenario: scenario as any,
    relay,
    runId,
    projectRoot: resolveWorkspaceRoot(),
    driverModule,
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

async function buildAutoloopArtifact(
  fetchImpl: typeof fetch,
  relay: string,
  finalRunId: string,
  autoloopId: string,
  baselineRunId: string
) {
  const [artifact, decision, autoloop, diff] = await Promise.all([
    requestJson(fetchImpl, `${relay}/ai/run/${finalRunId}/artifact`),
    requestJson(fetchImpl, `${relay}/ai/autoloop/${autoloopId}/decision`),
    requestJson(fetchImpl, `${relay}/ai/autoloop/${autoloopId}`),
    requestJson(fetchImpl, `${relay}/ai/diff?baselineRunId=${baselineRunId}&currentRunId=${finalRunId}`),
  ]);
  return {
    autoloopId,
    finalRunId,
    baselineRunId,
    artifact: artifact.artifact,
    decision: decision.decision,
    autoloop: autoloop.autoloop,
    diff: diff.changed || [],
  };
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

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const fetchImpl = deps.fetchImpl || fetch;
  const spawnImpl = deps.spawnImpl || spawn;
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
      const mode = (options.params.mode || options.params.scenario || "baseline") as "baseline" | "broken" | "fixed";
      const orchestration = await createRunForScenario(
        fetchImpl,
        options.relay,
        options.params.label || `web-${mode}`,
        mode,
        options.params.baselineRunId
      );
      const result = await runWebScenario(fetchImpl, spawnImpl, options.relay, orchestration.runId, mode, options.params.baselineRunId);
      const artifact = await requestJson(
        fetchImpl,
        `${options.relay}/ai/run/${orchestration.runId}/artifact${options.artifact ? `?path=${encodeURIComponent(options.artifact)}` : ""}`
      );
      stdout(
        format(
          {
            runId: orchestration.runId,
            mode,
            ...result,
            artifactPath: artifact.filePath,
          },
          options.pretty
        )
      );
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
      const mode = (options.params.mode || "fixed") as "baseline" | "broken" | "fixed";
      const runId = options.params.runId;
      const result = await runWebScenario(fetchImpl, spawnImpl, options.relay, runId, mode, options.params.baselineRunId);
      stdout(format({ ok: true, runId, mode, ...result }, options.pretty));
      return 0;
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

      let baselineRunId = options.params.baselineRunId || "";
      if (!baselineRunId) {
        const baselineRun = await createRunForScenario(fetchImpl, options.relay, "autoloop-baseline", "baseline");
        await runWebScenario(fetchImpl, spawnImpl, options.relay, baselineRun.runId, "baseline");
        baselineRunId = baselineRun.runId;
      }

      const started = await postJson(fetchImpl, `${options.relay}/autoloops/start`, {
        triggerReason: options.params.triggerReason || "runtime_change_detected",
        target: "web",
        scenario: options.params.scenario || "broken",
        baselineRunId,
        maxAttempts: options.params.maxAttempts ? Number(options.params.maxAttempts) : 3,
        entryContext: {
          task: options.params.task || "auto_loop",
          projectRoot: resolveWorkspaceRoot(),
        },
      });

      const autoloopId = started.autoloopId as string;
      const brokenRunId = started.runId as string;
      const attempt1 = await postJson(fetchImpl, `${options.relay}/autoloops/${autoloopId}/attempts/start`, {
        baselineRunId,
        currentRunId: brokenRunId,
      });
      const broken = await runWebScenario(fetchImpl, spawnImpl, options.relay, brokenRunId, "broken", baselineRunId);
      const brokenDecision = await requestJson(fetchImpl, `${options.relay}/ai/autoloop/${autoloopId}/decision`);
      await postJson(fetchImpl, `${options.relay}/autoloops/${autoloopId}/attempts/${attempt1.attempt.id}/repair-outcome`, {
        changedFiles: ["examples/web-playwright/demo-page"],
        assumptionDelta: ["Switch broken scenario to fixed behavior on retest"],
        riskLevel: "medium",
        notes: "Demo repair outcome recorded for broken -> fixed loop.",
      });
      await postJson(fetchImpl, `${options.relay}/autoloops/${autoloopId}/attempts/${attempt1.attempt.id}/complete`, {
        result: brokenDecision.decision.shouldContinue ? "needs_repair" : "halted_after_collection",
        stopDecision: brokenDecision.decision,
      });

      let finalRunId = brokenRunId;
      let fixed = null;
      let compare = null;

      if (brokenDecision.decision.shouldContinue) {
        const fixedRun = await createRunForScenario(fetchImpl, options.relay, "autoloop-fixed", "fixed", baselineRunId);
        finalRunId = fixedRun.runId;
        const attempt2 = await postJson(fetchImpl, `${options.relay}/autoloops/${autoloopId}/attempts/start`, {
          baselineRunId,
          currentRunId: finalRunId,
        });
        fixed = await runWebScenario(fetchImpl, spawnImpl, options.relay, finalRunId, "fixed", baselineRunId);
        compare = await requestJson(fetchImpl, `${options.relay}/ai/diff?baselineRunId=${baselineRunId}&currentRunId=${finalRunId}`);
        const finalDecision = await requestJson(fetchImpl, `${options.relay}/ai/autoloop/${autoloopId}/decision`);
        await postJson(fetchImpl, `${options.relay}/autoloops/${autoloopId}/attempts/${attempt2.attempt.id}/repair-outcome`, {
          changedFiles: ["examples/web-playwright/demo-page"],
          assumptionDelta: ["Retest completed against fixed scenario"],
          riskLevel: "low",
          notes: "Retest outcome recorded.",
        });
        await postJson(fetchImpl, `${options.relay}/autoloops/${autoloopId}/attempts/${attempt2.attempt.id}/complete`, {
          result: finalDecision.decision.status,
          stopDecision: finalDecision.decision,
        });
      }

      const payload = await buildAutoloopArtifact(fetchImpl, options.relay, finalRunId, autoloopId, baselineRunId);
      const report = await requestJson(fetchImpl, `${options.relay}/ai/run/${finalRunId}/report`);
      const autoloopPayload = {
        ...payload,
        brokenRunId,
        broken,
        fixed,
        compare: compare?.changed || [],
        report: report.report,
      };
      const written = await maybeWriteArtifact(options.artifact, autoloopPayload);
      stdout(
        format(
          {
            ok: true,
            triggerDecision: triggerDecision.decision,
            webVerify: projectVerify.runtimeReadiness,
            projectVerify,
            ...autoloopPayload,
            artifactPath: written || options.artifact || "",
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
      const runStart = await createMiniappRun(fetchImpl, options.relay, options.params.label || templateName, driver, scenario.id);
      const runId = runStart.runId as string;
      const contract = await fetchDriverContract(fetchImpl, options.relay, { target: "miniapp", driver });
      const execution = await runMiniappScenarioExecution(fetchImpl, options.relay, runId, driver, scenario, projectCheck.report, options.params.driverModule || "");
      if (execution.status === "bridge_required") {
        stdout(
          format(
            {
              ok: true,
              status: "bridge_required",
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
            },
            options.pretty
          )
        );
        return 0;
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
        ...bundle,
      };
      const written = await maybeWriteArtifact(options.artifact, payload);
      stdout(format({ ...payload, artifactPath: written }, options.pretty));
      return execution.status === "driver_not_available" ? 1 : 0;
    }

    if (command[0] === "miniapp" && command[1] === "scenario") {
      const templateName = options.params.templateName || options.params.scenario || "miniapp_home_entry";
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
      stdout(
        format(
          {
            ok: true,
            runId: options.params.runId,
            driverContract: contract.contract,
            ...bundle,
          },
          options.pretty
        )
      );
      return bundle.releaseDecision?.decision === "hold" ? 1 : 0;
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
