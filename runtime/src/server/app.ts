import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { RelayConfig } from "../config.js";
import type {
  AutoloopAttemptCompleteInput,
  AutoloopAttemptStartInput,
  AutoloopStartInput,
  BlackboxRunReport,
  BlackboxDiscoverSummary,
  CheckpointInput,
  EndRunInput,
  EndStepInput,
  IngestBatchEnvelope,
  LogLevel,
  OrchestrationStartInput,
  RepairOutcome,
  RelayLogInput,
  RunStatus,
  StartRunInput,
  StartStepInput,
  TestTarget,
  TriggerPhase,
} from "../types.js";
import { RelayEngine } from "../core/relay-engine.js";
import { AiQueryService } from "../ai/service.js";
import { validateBlackboxRunReport } from "../core/validation.js";
import { collectWebObserveInventory, discoverWebUiFromHtml } from "../core/blackbox-observe.js";
import { relayFailure } from "../core/gate-evaluator.js";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === "running" || value === "passed" || value === "failed" || value === "aborted";
}

function isTarget(value: unknown): value is TestTarget {
  return value === "web" || value === "miniapp" || value === "mixed";
}

function standardFailure(reasonCode: string, message: string, recommendedAction: string) {
  const family = reasonCode.includes("driver")
    ? "driver"
    : reasonCode.includes("evidence") || reasonCode.includes("artifact")
      ? "evidence"
      : reasonCode.includes("target")
        ? "target"
        : reasonCode.includes("store")
          ? "store"
          : reasonCode.includes("blackbox")
            ? "blackbox"
            : "harness";
  return {
    ok: false,
    reasonCode,
    message,
    failure: relayFailure({
      reasonCode,
      family,
      userMessage: message,
      recommendedAction,
    }),
  };
}

function isTriggerPhase(value: unknown): value is TriggerPhase {
  return value === "code_change" || value === "self_test" || value === "retest" || value === "regression_check" || value === "incident_review" || value === "manual";
}

function normalizeStartRun(body: unknown): StartRunInput {
  const payload = asObject(body);
  return {
    label: typeof payload.label === "string" ? payload.label : undefined,
    target: isTarget(payload.target) ? payload.target : undefined,
    metadata: asObject(payload.metadata),
  };
}

function normalizeOrchestrationStart(body: unknown): OrchestrationStartInput {
  const payload = asObject(body);
  return {
    ...normalizeStartRun(body),
    scenario: typeof payload.scenario === "string" ? payload.scenario : undefined,
    baselineRunId: typeof payload.baselineRunId === "string" ? payload.baselineRunId : undefined,
  };
}

function normalizeAutoloopStart(body: unknown): AutoloopStartInput {
  const payload = asObject(body);
  return {
    triggerReason: typeof payload.triggerReason === "string" ? payload.triggerReason : undefined,
    target: isTarget(payload.target) ? payload.target : undefined,
    scenario: typeof payload.scenario === "string" ? payload.scenario : undefined,
    baselineRunId: typeof payload.baselineRunId === "string" ? payload.baselineRunId : undefined,
    maxAttempts: Number.isFinite(Number(payload.maxAttempts)) ? Number(payload.maxAttempts) : undefined,
    entryContext: asObject(payload.entryContext),
  };
}

function normalizeAutoloopAttemptStart(body: unknown): AutoloopAttemptStartInput {
  const payload = asObject(body);
  return {
    baselineRunId: typeof payload.baselineRunId === "string" ? payload.baselineRunId : undefined,
    currentRunId: typeof payload.currentRunId === "string" ? payload.currentRunId : undefined,
  };
}

function normalizeAutoloopAttemptComplete(body: unknown): AutoloopAttemptCompleteInput {
  const payload = asObject(body);
  return {
    result: typeof payload.result === "string" ? payload.result : undefined,
    stopDecision: payload.stopDecision && typeof payload.stopDecision === "object"
      ? {
          status:
            (payload.stopDecision as Record<string, unknown>).status === "resolved" ||
            (payload.stopDecision as Record<string, unknown>).status === "halted" ||
            (payload.stopDecision as Record<string, unknown>).status === "escalated"
              ? ((payload.stopDecision as Record<string, unknown>).status as "resolved" | "halted" | "escalated")
              : "escalated",
          reason: String((payload.stopDecision as Record<string, unknown>).reason || ""),
          confidence: Number((payload.stopDecision as Record<string, unknown>).confidence || 0),
          evidence: Array.isArray((payload.stopDecision as Record<string, unknown>).evidence)
            ? ((payload.stopDecision as Record<string, unknown>).evidence as unknown[]).map((item) => String(item))
            : [],
          shouldContinue: Boolean((payload.stopDecision as Record<string, unknown>).shouldContinue),
          nextAction: String((payload.stopDecision as Record<string, unknown>).nextAction || ""),
        }
      : undefined,
  };
}

function normalizeRepairOutcome(body: unknown): RepairOutcome {
  const payload = asObject(body);
  return {
    changedFiles: Array.isArray(payload.changedFiles) ? payload.changedFiles.map((item) => String(item)) : [],
    assumptionDelta: Array.isArray(payload.assumptionDelta) ? payload.assumptionDelta.map((item) => String(item)) : [],
    riskLevel: payload.riskLevel === "low" || payload.riskLevel === "medium" || payload.riskLevel === "high" ? payload.riskLevel : "medium",
    notes: typeof payload.notes === "string" ? payload.notes : "",
  };
}

function normalizeStartStep(body: unknown): StartStepInput {
  const payload = asObject(body);
  return {
    name: typeof payload.name === "string" ? payload.name : undefined,
    kind:
      payload.kind === "setup" ||
      payload.kind === "navigate" ||
      payload.kind === "action" ||
      payload.kind === "assert" ||
      payload.kind === "network" ||
      payload.kind === "custom"
        ? payload.kind
        : undefined,
    route: typeof payload.route === "string" ? payload.route : undefined,
    metadata: asObject(payload.metadata),
  };
}

function normalizeEndStep(body: unknown): EndStepInput {
  const payload = asObject(body);
  return {
    status:
      payload.status === "running" || payload.status === "passed" || payload.status === "failed" || payload.status === "aborted"
        ? payload.status
        : undefined,
    metadata: asObject(payload.metadata),
  };
}

function normalizeEndRun(body: unknown): EndRunInput {
  const payload = asObject(body);
  return {
    status: isRunStatus(payload.status) ? payload.status : undefined,
    metadata: asObject(payload.metadata),
  };
}

function normalizeCheckpoint(body: unknown): CheckpointInput {
  const payload = asObject(body);
  return {
    name: typeof payload.name === "string" ? payload.name : undefined,
    stepId: typeof payload.stepId === "string" ? payload.stepId : undefined,
    metadata: asObject(payload.metadata),
  };
}

function isRelayLogInput(payload: unknown): payload is RelayLogInput {
  const input = payload as RelayLogInput;
  return Boolean(input && isLogLevel(input.level) && typeof input.message === "string" && typeof input.source === "string");
}

function requestWorkspaceRoot(request: { headers: Record<string, unknown> }): string | undefined {
  const value = request.headers["x-dev-log-relay-workspace-root"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function workspaceMatchesTargetProject(workspaceRoot: string | undefined, targetProject: Record<string, unknown>): boolean {
  if (!workspaceRoot) return true;
  const value = typeof targetProject.workspaceRoot === "string" ? targetProject.workspaceRoot : "";
  return Boolean(value && path.resolve(value) === path.resolve(workspaceRoot));
}

function normalizeGoals(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split("\n").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

async function discoverWebUi(url: string): Promise<BlackboxDiscoverSummary> {
  const { chromium } = await import("playwright");
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return discoverWebUiFromHtml(fetch, url, error instanceof Error ? error.message : String(error));
  }
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(300);
    const accessibilityApi = (page as any).accessibility;
    const accessibility = accessibilityApi ? await accessibilityApi.snapshot({ interestingOnly: true }).catch(() => null) : null;
    const summary = await page.evaluate(collectWebObserveInventory);
    return {
      target: "web",
      targetUrl: url,
      title: summary.title,
      visibleText: summary.visibleText,
      accessibilitySummary: JSON.stringify(accessibility || {}).slice(0, 4000),
      controls: summary.controls as BlackboxDiscoverSummary["controls"],
      actionCandidates: summary.actionCandidates as BlackboxDiscoverSummary["actionCandidates"],
      locatorCandidates: summary.locatorCandidates as BlackboxDiscoverSummary["locatorCandidates"],
      riskFlags: summary.riskFlags as string[],
      coverageHints: summary.coverageHints as string[],
      errorTokens: summary.errorTokens,
      emptyTokens: summary.emptyTokens,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return discoverWebUiFromHtml(fetch, url, error instanceof Error ? error.message : String(error));
  } finally {
    await browser.close();
  }
}

export function createRelayServer(config: RelayConfig): FastifyInstance {
  const server = Fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  const engine = new RelayEngine(config);
  const ai = new AiQueryService(engine);

  server.get("/healthz", async () => ({
    ok: true,
    ...engine.health(),
  }));

  server.post("/runs/start", async (request, reply) => {
    const input = normalizeStartRun(request.body);
    const projectRoot = requestWorkspaceRoot(request);
    if (projectRoot) {
      input.metadata = { ...input.metadata, projectRoot };
    }
    const run = engine.startRun(input);
    return reply.send({ ok: true, runId: run.id, run });
  });

  server.post("/orchestrations/start", async (request, reply) => {
    const input = normalizeOrchestrationStart(request.body);
    const projectRoot = requestWorkspaceRoot(request);
    if (projectRoot) {
      input.metadata = { ...input.metadata, projectRoot };
    }
    const { run, session } = ai.startOrchestration(input);
    return reply.send({
      ok: true,
      runId: run.id,
      run,
      orchestration: session,
      defaultContextWindow: config.contextWindowSize,
    });
  });

  server.post("/autoloops/start", async (request, reply) => {
    const input = normalizeAutoloopStart(request.body);
    const projectRoot = requestWorkspaceRoot(request);
    if (projectRoot) {
      input.entryContext = { ...input.entryContext, projectRoot };
    }
    const { run, orchestration, session } = ai.startAutoloop(input);
    return reply.send({
      ok: true,
      autoloopId: session.id,
      runId: run.id,
      run,
      orchestration,
      session,
      defaultContextWindow: config.contextWindowSize,
      artifactPathHint: `artifacts/${run.id}.json`,
    });
  });

  server.post<{ Params: { id: string } }>("/autoloops/:id/attempts/start", async (request, reply) => {
    const attempt = ai.startAutoloopAttempt(request.params.id, normalizeAutoloopAttemptStart(request.body));
    if (!attempt) {
      return reply.code(404).send(standardFailure("autoloop_not_found", "autoloop not found", "Start an autoloop session before recording attempts."));
    }
    return reply.send({ ok: true, attempt });
  });

  server.post<{ Params: { id: string; attemptId: string } }>("/autoloops/:id/attempts/:attemptId/complete", async (request, reply) => {
    const result = ai.completeAutoloopAttempt(request.params.id, request.params.attemptId, normalizeAutoloopAttemptComplete(request.body));
    if (!result) {
      return reply.code(404).send(standardFailure("autoloop_attempt_not_found", "autoloop attempt not found", "Use an attemptId from the same autoloop session."));
    }
    return reply.send({ ok: true, ...result });
  });

  server.post<{ Params: { id: string; attemptId: string } }>("/autoloops/:id/attempts/:attemptId/repair-outcome", async (request, reply) => {
    const outcome = ai.recordRepairOutcome(request.params.id, request.params.attemptId, normalizeRepairOutcome(request.body));
    if (!outcome) {
      return reply.code(404).send(standardFailure("autoloop_attempt_not_found", "autoloop attempt not found", "Use an attemptId from the same autoloop session."));
    }
    return reply.send({ ok: true, repairOutcome: outcome });
  });

  server.post<{ Params: { runId: string } }>("/orchestrations/:runId/checkpoint", async (request, reply) => {
    const checkpoint = ai.checkpoint(request.params.runId, normalizeCheckpoint(request.body));
    if (!checkpoint) {
      return reply.code(404).send(standardFailure("run_or_step_not_found", "run or step not found", "Record checkpoints against a stored run and step."));
    }
    return reply.send({ ok: true, checkpoint });
  });

  server.post<{ Params: { runId: string } }>("/runs/:runId/steps/start", async (request, reply) => {
    const step = engine.startStep(request.params.runId, normalizeStartStep(request.body));
    if (!step) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Start a real run before creating steps."));
    }
    return reply.send({ ok: true, stepId: step.id, step });
  });

  server.post<{ Params: { runId: string; stepId: string } }>("/runs/:runId/steps/:stepId/end", async (request, reply) => {
    const step = engine.endStep(request.params.runId, request.params.stepId, normalizeEndStep(request.body));
    if (!step) {
      return reply.code(404).send(standardFailure("step_not_found", "step not found", "Use a stepId from the same run."));
    }
    return reply.send({ ok: true, step });
  });

  server.post<{ Params: { runId: string } }>("/runs/:runId/end", async (request, reply) => {
    const run = engine.endRun(request.params.runId, normalizeEndRun(request.body));
    if (!run) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Start a real run before ending it."));
    }
    return reply.send({ ok: true, run });
  });

  server.post<{ Body: RelayLogInput | IngestBatchEnvelope }>("/ingest", async (request, reply) => {
    const payload = request.body;
    if (payload && typeof payload === "object" && Array.isArray((payload as IngestBatchEnvelope).records)) {
      const envelope = payload as IngestBatchEnvelope;
      const validRecords = (envelope.records || []).filter(isRelayLogInput);
      if (validRecords.length !== (envelope.records || []).length) {
        return reply.code(400).send(standardFailure("ingest_batch_invalid", "invalid record in batch", "Submit only valid relay log records with source, level, and message."));
      }
      const stats = engine.ingestBatch(validRecords, {
        runId: typeof envelope.runId === "string" ? envelope.runId : undefined,
        stepId: typeof envelope.stepId === "string" ? envelope.stepId : undefined,
      });
      return reply.send({ ok: true, batch: true, ...stats });
    }
    if (!isRelayLogInput(payload)) {
      return reply.code(400).send(standardFailure("ingest_payload_invalid", "invalid payload", "Submit a valid relay log input or ingest batch envelope."));
    }
    const result = engine.ingest(payload);
    return reply.send({
      ok: result.accepted,
      dropped: result.dropped,
      reason: result.reason || "",
      lateEvent: Boolean(result.lateEvent),
      eventId: result.eventId || "",
    });
  });

  server.get("/ai/runs", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = clampInt(query.limit, 20, 1, 200);
    const status = isRunStatus(query.status) ? query.status : undefined;
    const target = isTarget(query.target) ? query.target : undefined;
    return {
      ok: true,
      runs: ai.runs(limit, status, target),
    };
  });

  server.get("/ai/targets/support", async (request) => {
    const query = request.query as Record<string, unknown>;
    const target = String(query.target || "");
    return {
      ok: true,
      report: ai.targetSupport(target),
    };
  });

  server.get("/ai/targets/detect", async (request) => {
    const query = request.query as Record<string, unknown>;
    return {
      ok: true,
      detection: await ai.detectTarget(typeof query.target === "string" ? query.target : undefined, requestWorkspaceRoot(request)),
    };
  });

  server.get("/ai/web/integration-guide", async () => {
    return {
      ok: true,
      guide: ai.webIntegrationGuide(),
    };
  });

  server.get("/ai/miniapp/integration-guide", async () => {
    return {
      ok: true,
      guide: ai.miniappIntegrationGuide(),
    };
  });

  server.get("/ai/driver/contract", async (request) => {
    const query = request.query as Record<string, unknown>;
    return {
      ok: true,
      contract: ai.driverContract(String(query.target || "web"), String(query.driver || "")),
    };
  });

  server.post("/ai/trigger/decision", async (request) => {
    const payload = asObject(request.body);
    return {
      ok: true,
      decision: ai.triggerDecision({
        target: String(payload.target || ""),
        reason: typeof payload.reason === "string" ? payload.reason : undefined,
        phase: isTriggerPhase(payload.phase) ? payload.phase : undefined,
        runtimeImpact: Boolean(payload.runtimeImpact),
      }),
    };
  });

  server.post("/ai/task/enforcement", async (request) => {
    const payload = asObject(request.body);
    return {
      ok: true,
      enforcement: ai.taskEnforcement({
        target: String(payload.target || ""),
        phase: isTriggerPhase(payload.phase) ? payload.phase : undefined,
        runtimeImpact: Boolean(payload.runtimeImpact),
        runId: typeof payload.runId === "string" ? payload.runId : undefined,
        closureClaim: Boolean(payload.closureClaim),
      }),
    };
  });

  server.post("/ai/project/identify", async (request, reply) => {
    const payload = asObject(request.body);
    const profile = await ai.identifyProject(typeof payload.target === "string" ? payload.target : undefined, requestWorkspaceRoot(request));
    if (!profile) {
      return reply.code(404).send(standardFailure("project_not_identified", "project not identified", "Run this skill from a supported Web or Miniapp target project."));
    }
    return {
      ok: true,
      profile,
    };
  });

  server.get("/ai/project/compatibility", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const compatibility = await ai.projectCompatibility(typeof query.target === "string" ? query.target : undefined, requestWorkspaceRoot(request));
    if (!compatibility) {
      return reply.code(404).send(standardFailure("project_compatibility_unavailable", "project compatibility unavailable", "Resolve or identify a supported target project first."));
    }
    return { ok: true, compatibility };
  });

  server.get("/ai/project/resolution", async (request) => {
    const query = request.query as Record<string, unknown>;
    return {
      ok: true,
      resolution: await ai.projectResolution(typeof query.target === "string" ? query.target : undefined, requestWorkspaceRoot(request)),
    };
  });

  server.get("/ai/project/profile", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = String(query.projectId || "");
    if (!projectId) {
      return reply.code(400).send(standardFailure("project_id_required", "projectId is required", "Pass projectId from project resolution or target detection."));
    }
    const profile = ai.projectProfile(projectId);
    if (!profile) {
      return reply.code(404).send(standardFailure("project_profile_not_found", "project profile not found", "Resolve or identify the target project before requesting its profile."));
    }
    return { ok: true, profile };
  });

  server.get("/ai/project/history", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = String(query.projectId || "");
    if (!projectId) {
      return reply.code(400).send(standardFailure("project_id_required", "projectId is required", "Pass projectId from project resolution or target detection."));
    }
    return { ok: true, history: ai.projectHistory(projectId) };
  });

  server.get("/ai/project/memory", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = String(query.projectId || "");
    if (!projectId) {
      return reply.code(400).send(standardFailure("project_id_required", "projectId is required", "Pass projectId from project resolution or target detection."));
    }
    const memory = ai.projectMemory(projectId);
    if (!memory) {
      return reply.code(404).send(standardFailure("project_memory_not_found", "project memory not found", "Identify the target project before requesting its memory."));
    }
    return { ok: true, memory };
  });

  server.get("/ai/web/project-check", async (request) => {
    return {
      ok: true,
      report: await ai.inspectWebProject(requestWorkspaceRoot(request)),
    };
  });

  server.get("/ai/miniapp/project-check", async (request) => {
    return {
      ok: true,
      report: await ai.inspectMiniappProject(requestWorkspaceRoot(request)),
    };
  });

  server.get("/ai/templates", async (request) => {
    const query = request.query as Record<string, unknown>;
    const target = isTarget(query.target) && query.target !== "mixed" ? query.target : undefined;
    return {
      ok: true,
      templates: ai.scenarioTemplates(target),
    };
  });

  server.get("/ai/scenarios", async (request) => {
    const query = request.query as Record<string, unknown>;
    const target = isTarget(query.target) && query.target !== "mixed" ? query.target : undefined;
    const catalog = ai.projectScenarios(target);
    return { ok: true, scenarios: catalog.scenarios.map((entry) => entry.scenario), catalog };
  });

  server.get("/ai/project/scenarios", async (request) => {
    const query = request.query as Record<string, unknown>;
    const target = isTarget(query.target) && query.target !== "mixed" ? query.target : undefined;
    const catalog = ai.projectScenarios(target);
    return { ok: true, scenarios: catalog.scenarios.map((entry) => entry.scenario), catalog };
  });

  server.get("/ai/project/baselines", async (request) => {
    const query = request.query as Record<string, unknown>;
    const target = isTarget(query.target) && query.target !== "mixed" ? query.target : undefined;
    return { ok: true, baselines: ai.projectBaselines(target) };
  });

  server.post("/ai/blackbox/plan", async (request, reply) => {
    const payload = asObject(request.body);
    const target = isTarget(payload.target) && payload.target !== "mixed" ? payload.target : "web";
    const projectRoot = requestWorkspaceRoot(request);
    const providedProjectCheck = asObject(payload.projectCheck);
    const projectCheck =
      Object.keys(providedProjectCheck).length > 0
        ? providedProjectCheck
        : target === "miniapp"
          ? await ai.inspectMiniappProject(projectRoot)
          : await ai.inspectWebProject(projectRoot);
    const targetProject = asObject(payload.targetProject);
    if (!workspaceMatchesTargetProject(projectRoot, targetProject)) {
      return reply.code(400).send({
        ok: false,
        reasonCode: "target_project_invalid",
        message: "blackbox plan targetProject.workspaceRoot must match the invocation workspace.",
      });
    }
    const url = String(targetProject.targetUrl || payload.url || "");
    const discoverSummary =
      payload.discoverSummary && typeof payload.discoverSummary === "object"
        ? payload.discoverSummary as BlackboxDiscoverSummary
        : target === "web" && url && payload.noDiscover !== true
          ? await discoverWebUi(url).catch(() => undefined)
          : undefined;
    try {
      return {
        ok: true,
        plan: ai.blackboxPlan({
          target,
          targetProject,
          goals: normalizeGoals(payload.goals),
          maxCases: clampInt(payload.maxCases, 5, 1, 20),
          allowMutations: payload.allowMutations === true || payload.allowMutations === "true" || payload.allowMutations === "1",
          projectCheck: projectCheck as Record<string, unknown>,
          discoverSummary,
        }),
      };
    } catch (error) {
      const reasonCode = error instanceof Error && error.message === "target_project_invalid" ? "target_project_invalid" : "blackbox_plan_invalid";
      return reply.code(400).send({
        ok: false,
        reasonCode,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/ai/blackbox/discover", async (request, reply) => {
    const payload = asObject(request.body);
    const target = isTarget(payload.target) && payload.target !== "mixed" ? payload.target : "web";
    if (target !== "web") {
      return reply.code(400).send(standardFailure("target_not_discoverable", "blackbox discover currently supports web targets.", "Use blackbox plan/run with a real Miniapp driver or ledger."));
    }
    const url = String(payload.url || asObject(payload.targetProject).targetUrl || "");
    if (!url) {
      return reply.code(400).send(standardFailure("target_project_url_required", "blackbox discover requires a target URL.", "Pass --url or DEV_LOG_RELAY_TARGET_URL for the real target project."));
    }
    const discoverSummary = await discoverWebUi(url);
    return { ok: true, discoverSummary };
  });

  server.get<{ Params: { planId: string } }>("/ai/blackbox/plan/:planId", async (request, reply) => {
    const plan = ai.blackboxPlanById(request.params.planId);
    if (!plan) return reply.code(404).send(standardFailure("blackbox_plan_not_found", "blackbox plan not found", "Create a blackbox plan first, then retry with its planId."));
    return { ok: true, plan };
  });

  server.post("/blackbox/run", async (request, reply) => {
    const payload = asObject(request.body);
    const report = payload.report && typeof payload.report === "object" ? payload.report as BlackboxRunReport : null;
    if (!report || !report.runId || !report.planId) {
      return reply.code(400).send(standardFailure("blackbox_report_invalid", "blackbox report with runId and planId is required", "Submit a validated BlackboxRunReport generated by relay blackbox run."));
    }
    const validation = validateBlackboxRunReport(report);
    if (!validation.ok) {
      return reply.code(400).send(standardFailure(validation.reasonCode || "blackbox_report_invalid", validation.message || "Blackbox report is invalid.", "Regenerate the report through relay blackbox run."));
    }
    const stored = ai.recordBlackboxReportResult(report);
    if (!stored.ok) {
      return reply.code(409).send(standardFailure(stored.reasonCode || "blackbox_report_invalid", stored.message || "Blackbox report could not be stored.", "Regenerate the report through relay blackbox run."));
    }
    return { ok: true, report: stored.report };
  });

  async function createHarnessFromStoredBlackbox(request: { body: unknown }, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
    const payload = asObject(request.body);
    const target = isTarget(payload.target) && payload.target !== "mixed" ? payload.target : "web";
    const blackboxRunId = String(payload.blackboxRunId || payload.runId || "");
    if (!blackboxRunId) {
      return reply.code(400).send({
        ok: false,
        reasonCode: "harness_blackbox_required",
        message: "server-side harness finalization requires a stored blackboxRunId; use relay harness verify for local driver orchestration or run blackbox first.",
        failure: relayFailure({
          reasonCode: "harness_blackbox_required",
          family: "harness",
          userMessage: "server-side harness finalization requires a stored blackboxRunId.",
          recommendedAction: "Use relay harness verify for local driver orchestration or run blackbox first.",
        }),
      });
    }
    const report = ai.createHarnessVerificationReport({
      target,
      driver: typeof payload.driver === "string" ? payload.driver : undefined,
      goals: normalizeGoals(payload.goals),
      blackboxRunId,
      targetProject: asObject(payload.targetProject),
      regressionSeedRef: typeof payload.regressionSeedRef === "string" ? payload.regressionSeedRef : undefined,
      executionContext: asObject(payload.executionContext),
    });
    if (!report) {
      return reply.code(404).send(standardFailure("harness_blackbox_required", "blackbox report not found; run blackbox before harness verification.", "Use relay harness verify for local orchestration or run blackbox first."));
    }
    return { ok: report.gate.status === "pass", harnessRunId: report.harnessRunId, harnessReport: report };
  }

  server.post("/ai/harness/from-blackbox-run", async (request, reply) => {
    return createHarnessFromStoredBlackbox(request, reply);
  });

  server.post("/ai/harness/verify", async (request, reply) => {
    return createHarnessFromStoredBlackbox(request, reply);
  });

  server.get<{ Params: { harnessRunId: string } }>("/ai/harness/:harnessRunId/report", async (request, reply) => {
    const report = ai.harnessVerificationReport(request.params.harnessRunId);
    if (!report) {
      return reply.code(404).send(standardFailure("harness_report_not_found", "harness report not found", "Check the harnessRunId or rerun relay harness verify."));
    }
    return { ok: report.gate.status === "pass", harnessReport: report };
  });

  server.get<{ Params: { harnessRunId: string } }>("/ai/harness/:harnessRunId/evidence", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const ref = typeof query.ref === "string" ? query.ref : "";
    const artifact = ref ? ai.harnessEvidenceArtifactRef(request.params.harnessRunId, ref) : null;
    if (!artifact) {
      return reply.code(400).send(standardFailure("harness_evidence_invalid", "artifact ref must be registered in the harness evidence index.", "Request only refs returned by harness report or store inspect."));
    }
    return { ok: true, artifact };
  });

  server.get("/ai/store/inspect", async (request) => {
    const query = request.query as Record<string, unknown>;
    const runId = typeof query.runId === "string" ? query.runId : undefined;
    const harnessRunId = typeof query.harnessRunId === "string" ? query.harnessRunId : undefined;
    return { ok: true, manifest: ai.inspectRuntimeStore({ runId, harnessRunId }) };
  });

  server.post("/ai/store/cleanup", async (request, reply) => {
    const payload = asObject(request.body);
    const olderThanDays = clampInt(payload.olderThanDays, 30, 0, 3650);
    const dryRun = payload.dryRun !== false && payload.confirm !== true;
    const confirm = payload.confirm === true;
    if (!dryRun && !confirm) {
      return reply.code(400).send(standardFailure("store_cleanup_confirmation_required", "store cleanup requires --confirm to delete files.", "Run cleanup with --dryRun first, then pass --confirm if the candidates are correct."));
    }
    return { ok: true, cleanup: ai.cleanupRuntimeStore({ olderThanDays, dryRun, confirm }) };
  });

  server.get("/ai/scenario/inspect", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const templateName = String(query.templateName || "");
    if (!templateName) {
      return reply.code(400).send(standardFailure("scenario_template_required", "templateName is required", "Pass a scenario templateName to inspect."));
    }
    const target = isTarget(query.target) && query.target !== "mixed" ? query.target : undefined;
    return { ok: true, inspection: ai.scenarioInspect(templateName, target) };
  });

  server.post("/scenarios/validate", async (request, reply) => {
    const payload = asObject(request.body);
    const runId = String(payload.runId || "");
    if (!runId) {
      return reply.code(400).send(standardFailure("run_id_required", "runId is required", "Start a real run before validating a scenario."));
    }
    const templateName = typeof payload.templateName === "string" ? payload.templateName : "";
    const spec =
      payload.spec && typeof payload.spec === "object"
        ? payload.spec
        : templateName
          ? ai.scenarioTemplates(isTarget(payload.target) && payload.target !== "mixed" ? payload.target : undefined).find((item) => item.id === templateName || item.templateName === templateName)
          : null;
    if (!spec) {
      return reply.code(400).send(standardFailure("scenario_spec_required", "scenario spec or valid templateName is required", "Submit a scenario spec or a valid templateName for the target."));
    }
    const report = ai.scenarioValidate(runId, spec);
    if (!report) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Validate scenarios against a stored real run."));
    }
    return { ok: true, scenario: report };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/timeline", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ ...standardFailure("run_not_found", "run not found", "Request timeline for a stored real run."), timeline: [] });
    }
    const query = request.query as Record<string, unknown>;
    const cursor = clampInt(query.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(query.limit, config.contextWindowSize, 1, 1000);
    const level = isLogLevel(query.level) ? query.level : undefined;
    return {
      ok: true,
      run,
      timeline: ai.runTimeline(request.params.runId, cursor, limit, level),
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/summary", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request summary for a stored real run."));
    }
    return {
      ok: true,
      run,
      summary: ai.runSummary(request.params.runId),
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/incidents", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ ...standardFailure("run_not_found", "run not found", "Request incidents for a stored real run."), incidents: [] });
    }
    const query = request.query as Record<string, unknown>;
    const limit = clampInt(query.limit, 20, 1, 200);
    return {
      ok: true,
      run,
      incidents: ai.runIncidents(request.params.runId, limit),
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/context", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ ...standardFailure("run_not_found", "run not found", "Request context for a stored real run."), events: [] });
    }
    const query = request.query as Record<string, unknown>;
    const fingerprint = String(query.fingerprint || "");
    if (!fingerprint) {
      return reply.code(400).send({ ...standardFailure("context_fingerprint_required", "fingerprint is required", "Pass the event fingerprint to fetch surrounding context."), events: [] });
    }
    const before = clampInt(query.before, config.contextWindowSize, 0, 500);
    const after = clampInt(query.after, config.contextWindowSize, 0, 500);
    return {
      ok: true,
      run,
      fingerprint,
      events: ai.runContext(request.params.runId, fingerprint, before, after),
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/flow", async (request, reply) => {
    const flow = ai.runFlow(request.params.runId);
    if (!flow) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request flow for a stored real run."));
    }
    return {
      ok: true,
      flow,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/diagnosis", async (request, reply) => {
    const diagnosis = ai.runDiagnosis(request.params.runId);
    if (!diagnosis) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request diagnosis for a stored real run."));
    }
    return {
      ok: true,
      diagnosis,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/closure", async (request, reply) => {
    const closure = ai.runClosure(request.params.runId);
    if (!closure) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request closure for a stored real run."));
    }
    return {
      ok: true,
      closure,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/integrity", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request integrity for a stored real run."));
    }
    return {
      ok: true,
      integrity: ai.runIntegrity(request.params.runId),
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/readiness", async (request, reply) => {
    const readiness = ai.runReadiness(request.params.runId);
    if (!readiness) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request readiness for a stored real run."));
    }
    return {
      ok: true,
      readiness,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/actions", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request actions for a stored real run."));
    return { ok: true, actions: ai.runActions(request.params.runId) };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/state-snapshots", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request state snapshots for a stored real run."));
    return { ok: true, stateSnapshots: ai.runStateSnapshots(request.params.runId) };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/request-attribution", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request request attribution for a stored real run."));
    return { ok: true, requestAttribution: ai.runRequestAttribution(request.params.runId) };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/report", async (request, reply) => {
    const report = ai.runReport(request.params.runId);
    if (!report) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request report for a stored real run."));
    }
    return {
      ok: true,
      report,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/release-decision", async (request, reply) => {
    const releaseDecision = ai.runReleaseDecision(request.params.runId);
    if (!releaseDecision) return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request release decision for a stored real run."));
    return { ok: true, releaseDecision };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/verification-report", async (request, reply) => {
    const verificationReport = ai.runVerificationReport(request.params.runId);
    if (!verificationReport) return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request verification report for a stored real run."));
    return { ok: true, verificationReport };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/driver-check", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const report = ai.runDriverCheck(request.params.runId, typeof query.driver === "string" ? query.driver : undefined);
    if (!report) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request driver check for a stored real run."));
    }
    return {
      ok: true,
      driverCheck: report,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/failure-chain", async (request, reply) => {
    const chain = ai.runFailureChain(request.params.runId);
    if (!chain) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request failure chain for a stored real run."));
    }
    return { ok: true, failureChain: chain };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/root-cause-map", async (request, reply) => {
    const rootCauseMap = ai.runRootCauseMap(request.params.runId);
    if (!rootCauseMap) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request root cause map for a stored real run."));
    }
    return { ok: true, rootCauseMap };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/repair-strategy", async (request, reply) => {
    const strategy = ai.runRepairStrategy(request.params.runId);
    if (!strategy) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request repair strategy for a stored real run."));
    }
    return { ok: true, repairStrategy: strategy };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/handoff", async (request, reply) => {
    const handoff = ai.runHandoff(request.params.runId);
    if (!handoff) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request handoff for a stored real run."));
    }
    return { ok: true, handoff };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/executable-handoff", async (request, reply) => {
    const handoff = ai.runExecutableHandoff(request.params.runId);
    if (!handoff) return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request executable handoff for a stored real run."));
    return { ok: true, handoff };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/miniapp-signals", async (request, reply) => {
    const report = ai.runMiniappSignals(request.params.runId);
    if (!report) {
      return reply.code(404).send(standardFailure("miniapp_run_not_found", "miniapp run not found", "Request Miniapp signals for a stored Miniapp run."));
    }
    return { ok: true, miniappSignals: report };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/miniapp-observation", async (request, reply) => {
    const report = ai.runMiniappObservation(request.params.runId);
    if (!report) {
      return reply.code(404).send(standardFailure("miniapp_run_not_found", "miniapp run not found", "Request Miniapp observation for a stored Miniapp run."));
    }
    return { ok: true, miniappObservation: report };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/collection", async (request, reply) => {
    const report = ai.runCollection(request.params.runId);
    if (!report) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request collection for a stored real run."));
    }
    return {
      ok: true,
      collection: report,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/scenario", async (request, reply) => {
    const scenario = ai.runScenario(request.params.runId);
    if (!scenario) {
      return reply.code(404).send(standardFailure("scenario_not_found", "scenario not found", "Validate or run a scenario before requesting scenario evidence."));
    }
    return { ok: true, scenario };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/blackbox-report", async (request, reply) => {
    const report = ai.runBlackboxReport(request.params.runId);
    if (!report) {
      return reply.code(404).send(standardFailure("blackbox_report_not_found", "blackbox report not found", "Run blackbox or harness verification before requesting a blackbox report."));
    }
    return { ok: true, blackboxReport: report };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/evidence-refs", async (request) => ({
    ok: true,
    evidenceRefs: ai.runEvidenceRefs(request.params.runId),
  }));

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/evidence-capsule", async (request, reply) => {
    const capsule = ai.runEvidenceCapsule(request.params.runId);
    if (!capsule) {
      return reply.code(404).send(standardFailure("evidence_capsule_not_found", "evidence capsule not found", "Run blackbox or harness verification before requesting an evidence capsule."));
    }
    return { ok: true, capsule };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/evidence-artifact", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const ref = typeof query.ref === "string" ? query.ref : "";
    const artifact = ref ? ai.runEvidenceArtifactRef(request.params.runId, ref) : null;
    if (!artifact) {
      return reply.code(400).send(standardFailure("evidence_artifact_ref_invalid", "artifact ref must point inside the relay runtime store.", "Request only refs returned by the report, capsule, trace, or store inspect."));
    }
    return { ok: true, artifact };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/blackbox-trace", async (request, reply) => {
    const traces = ai.runBlackboxTrace(request.params.runId);
    if (!traces.length) {
      return reply.code(404).send(standardFailure("blackbox_trace_not_found", "blackbox trace not found", "Run blackbox verification before requesting action traces."));
    }
    const query = request.query as Record<string, unknown>;
    const format = String(query.format || "summary");
    if (format === "playwright") {
      return { ok: true, playwrightTraces: ai.runEvidenceRefs(request.params.runId).playwrightTraces || [] };
    }
    if (format === "relay") {
      return { ok: true, traces };
    }
    return {
      ok: true,
      summary: traces.map((trace) => ({
        caseId: trace.caseId,
        status: trace.status,
        actions: trace.actions.length,
        assertions: trace.assertionResults,
        screenshotRef: trace.screenshotRef,
        accessibilityRef: trace.accessibilityRef,
      })),
      evidenceRefs: ai.runEvidenceRefs(request.params.runId),
    };
  });

  server.post<{ Params: { runId: string } }>("/ai/run/:runId/seed-regression", async (request, reply) => {
    const artifact = ai.seedRegressionFromRun(request.params.runId);
    if (!artifact) {
      return reply.code(404).send(standardFailure("blackbox_report_not_found", "blackbox report not found", "Run blackbox or harness verification before seeding regression."));
    }
    return { ok: true, regressionSeed: artifact };
  });

  server.post("/ai/benchmark/blackbox", async (request, reply) => {
    const payload = asObject(request.body);
    const report = payload.report && typeof payload.report === "object" ? payload.report as any : null;
    const validTargets = new Set(["web", "miniapp", "mixed"]);
    if (
      !report ||
      typeof report.benchmarkId !== "string" ||
      typeof report.fixture !== "string" ||
      !validTargets.has(String(report.target)) ||
      typeof report.passed !== "number" ||
      typeof report.failed !== "number" ||
      typeof report.manualReview !== "number" ||
      !Array.isArray(report.reports) ||
      !Array.isArray(report.failureTaxonomy) ||
      !Array.isArray(report.coverageGaps)
    ) {
      return reply.code(400).send(standardFailure("benchmark_report_invalid", "benchmark report is required and must match the runtime schema.", "Submit a benchmark report generated by relay benchmark blackbox."));
    }
    return { ok: true, benchmark: ai.saveBenchmarkReport(report) };
  });

  server.post<{ Params: { runId: string } }>("/ai/run/:runId/blackbox-export", async (request, reply) => {
    const payload = asObject(request.body);
    const format = payload.format === "playwright" || !payload.format ? "playwright" : "";
    if (!format) {
      return reply.code(400).send(standardFailure("blackbox_export_format_invalid", "Only playwright export is supported.", "Use --format playwright."));
    }
    const artifact = ai.exportBlackboxRun(request.params.runId, "playwright");
    if (!artifact) {
      return reply.code(404).send(standardFailure("blackbox_export_source_not_found", "blackbox export source not found", "Export only after a stored blackbox report exists."));
    }
    return { ok: true, export: artifact };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/state-report", async (request, reply) => {
    const stateReport = ai.runStateReport(request.params.runId);
    if (!stateReport) {
      return reply.code(404).send(standardFailure("state_report_not_found", "state report not found", "Request state reports for a stored run with state evidence."));
    }
    return { ok: true, stateReport };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/baseline", async (request, reply) => {
    const baseline = ai.runBaseline(request.params.runId);
    if (!baseline) {
      return reply.code(404).send(standardFailure("baseline_not_found", "baseline not found", "Capture or request a baseline for a stored run."));
    }
    return { ok: true, baseline };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/hotspots", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ ...standardFailure("run_not_found", "run not found", "Request hotspots for a stored real run."), hotspots: [] });
    }
    return {
      ok: true,
      hotspots: ai.runHotspots(request.params.runId),
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/repair-brief", async (request, reply) => {
    const brief = ai.runRepairBrief(request.params.runId);
    if (!brief) {
      return reply.code(404).send(standardFailure("run_not_found", "run not found", "Request repair brief for a stored real run."));
    }
    return {
      ok: true,
      repairBrief: brief,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/artifact", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const filePath = typeof query.path === "string" ? query.path : undefined;
    try {
      const artifact = await ai.runArtifact(request.params.runId, filePath);
      return {
        ok: true,
        ...artifact,
      };
    } catch (error) {
      return reply.code(404).send(standardFailure("artifact_unavailable", error instanceof Error ? error.message : "artifact unavailable", "Request artifacts for a stored run and a safe artifact path."));
    }
  });

  server.get<{ Params: { id: string } }>("/ai/autoloop/:id", async (request, reply) => {
    const autoloop = ai.autoloop(request.params.id);
    if (!autoloop) {
      return reply.code(404).send(standardFailure("autoloop_not_found", "autoloop not found", "Start an autoloop session before requesting it."));
    }
    return {
      ok: true,
      autoloop,
    };
  });

  server.get<{ Params: { id: string } }>("/ai/autoloop/:id/decision", async (request, reply) => {
    const decision = ai.autoloopDecision(request.params.id);
    if (!decision) {
      return reply.code(404).send(standardFailure("autoloop_not_found", "autoloop not found", "Start an autoloop session before requesting its decision."));
    }
    return {
      ok: true,
      decision,
    };
  });

  server.get("/ai/incidents", async (request) => {
    const query = request.query as Record<string, unknown>;
    const window = clampInt(query.window, 15, 1, 24 * 60);
    const limit = clampInt(query.limit, 20, 1, 200);
    return {
      ok: true,
      ...ai.incidents(window, limit),
    };
  });

  server.get("/ai/context", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const fingerprint = String(query.fingerprint || "");
    if (!fingerprint) {
      return reply.code(400).send({ ...standardFailure("context_fingerprint_required", "fingerprint is required", "Pass the event fingerprint to fetch surrounding context."), events: [] });
    }
    const before = clampInt(query.before, config.contextWindowSize, 0, 500);
    const after = clampInt(query.after, config.contextWindowSize, 0, 500);
    return {
      ok: true,
      ...ai.context(fingerprint, before, after),
    };
  });

  server.get("/ai/diff", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const baselineRunId = String(query.baselineRunId || "");
    const currentRunId = String(query.currentRunId || "");
    if (baselineRunId && currentRunId) {
      return {
        ok: true,
        ...ai.runDiff(baselineRunId, currentRunId),
      };
    }
    const baseline = String(query.baseline || "");
    const current = String(query.current || "");
    if (!baseline || !current) {
      return reply.code(400).send({ ...standardFailure("diff_input_required", "baseline/current or baselineRunId/currentRunId are required", "Pass baseline/current payloads or baselineRunId/currentRunId."), changed: [] });
    }
    return {
      ok: true,
      ...ai.diff(baseline, current),
    };
  });

  server.get("/ai/diff/scenario", async (request) => {
    const query = request.query as Record<string, unknown>;
    return {
      ok: true,
      ...ai.runScenarioDiff(String(query.baselineRunId || ""), String(query.currentRunId || "")),
    };
  });

  server.get("/ai/diff/regression", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const baselineRunId = String(query.baselineRunId || "");
    const currentRunId = String(query.currentRunId || "");
    if (!baselineRunId || !currentRunId) {
      return reply.code(400).send(standardFailure("regression_diff_runs_required", "baselineRunId and currentRunId are required", "Pass both baselineRunId and currentRunId."));
    }
    return {
      ok: true,
      regression: ai.runRegressionDiff(baselineRunId, currentRunId, typeof query.scenarioId === "string" ? query.scenarioId : undefined),
    };
  });

  server.get("/ai/diff/state", async (request) => {
    const query = request.query as Record<string, unknown>;
    return {
      ok: true,
      ...ai.runStateDiff(String(query.baselineRunId || ""), String(query.currentRunId || "")),
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/summary-view", async (request, reply) => {
    const summary = ai.runSummaryView(request.params.runId);
    if (!summary) {
      return reply.code(404).send(standardFailure("summary_not_found", "summary not found", "Request summary view for a stored real run."));
    }
    return { ok: true, summary };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/failure-report", async (request, reply) => {
    const failureReport = ai.runFailureReport(request.params.runId);
    if (!failureReport) {
      return reply.code(404).send(standardFailure("failure_report_not_found", "failure report not found", "Request failure report for a stored real run."));
    }
    return { ok: true, failureReport };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/pr-comment", async (request, reply) => {
    const prComment = ai.runPrComment(request.params.runId);
    if (!prComment) {
      return reply.code(404).send(standardFailure("pr_comment_not_found", "pr comment not found", "Request PR comment for a stored real run."));
    }
    return { ok: true, prComment };
  });

  return server;
}
