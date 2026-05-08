import Fastify, { type FastifyInstance } from "fastify";
import type { RelayConfig } from "../config.js";
import type {
  AutoloopAttemptCompleteInput,
  AutoloopAttemptStartInput,
  AutoloopStartInput,
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
    const run = engine.startRun(normalizeStartRun(request.body));
    return reply.send({ ok: true, runId: run.id, run });
  });

  server.post("/orchestrations/start", async (request, reply) => {
    const { run, session } = ai.startOrchestration(normalizeOrchestrationStart(request.body));
    return reply.send({
      ok: true,
      runId: run.id,
      run,
      orchestration: session,
      defaultContextWindow: config.contextWindowSize,
    });
  });

  server.post("/autoloops/start", async (request, reply) => {
    const { run, orchestration, session } = ai.startAutoloop(normalizeAutoloopStart(request.body));
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
      return reply.code(404).send({ ok: false, message: "autoloop not found" });
    }
    return reply.send({ ok: true, attempt });
  });

  server.post<{ Params: { id: string; attemptId: string } }>("/autoloops/:id/attempts/:attemptId/complete", async (request, reply) => {
    const result = ai.completeAutoloopAttempt(request.params.id, request.params.attemptId, normalizeAutoloopAttemptComplete(request.body));
    if (!result) {
      return reply.code(404).send({ ok: false, message: "autoloop attempt not found" });
    }
    return reply.send({ ok: true, ...result });
  });

  server.post<{ Params: { id: string; attemptId: string } }>("/autoloops/:id/attempts/:attemptId/repair-outcome", async (request, reply) => {
    const outcome = ai.recordRepairOutcome(request.params.id, request.params.attemptId, normalizeRepairOutcome(request.body));
    if (!outcome) {
      return reply.code(404).send({ ok: false, message: "autoloop attempt not found" });
    }
    return reply.send({ ok: true, repairOutcome: outcome });
  });

  server.post<{ Params: { runId: string } }>("/orchestrations/:runId/checkpoint", async (request, reply) => {
    const checkpoint = ai.checkpoint(request.params.runId, normalizeCheckpoint(request.body));
    if (!checkpoint) {
      return reply.code(404).send({ ok: false, message: "run or step not found" });
    }
    return reply.send({ ok: true, checkpoint });
  });

  server.post<{ Params: { runId: string } }>("/runs/:runId/steps/start", async (request, reply) => {
    const step = engine.startStep(request.params.runId, normalizeStartStep(request.body));
    if (!step) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return reply.send({ ok: true, stepId: step.id, step });
  });

  server.post<{ Params: { runId: string; stepId: string } }>("/runs/:runId/steps/:stepId/end", async (request, reply) => {
    const step = engine.endStep(request.params.runId, request.params.stepId, normalizeEndStep(request.body));
    if (!step) {
      return reply.code(404).send({ ok: false, message: "step not found" });
    }
    return reply.send({ ok: true, step });
  });

  server.post<{ Params: { runId: string } }>("/runs/:runId/end", async (request, reply) => {
    const run = engine.endRun(request.params.runId, normalizeEndRun(request.body));
    if (!run) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return reply.send({ ok: true, run });
  });

  server.post<{ Body: RelayLogInput | IngestBatchEnvelope }>("/ingest", async (request, reply) => {
    const payload = request.body;
    if (payload && typeof payload === "object" && Array.isArray((payload as IngestBatchEnvelope).records)) {
      const envelope = payload as IngestBatchEnvelope;
      const validRecords = (envelope.records || []).filter(isRelayLogInput);
      if (validRecords.length !== (envelope.records || []).length) {
        return reply.code(400).send({ ok: false, message: "invalid record in batch" });
      }
      const stats = engine.ingestBatch(validRecords, {
        runId: typeof envelope.runId === "string" ? envelope.runId : undefined,
        stepId: typeof envelope.stepId === "string" ? envelope.stepId : undefined,
      });
      return reply.send({ ok: true, batch: true, ...stats });
    }
    if (!isRelayLogInput(payload)) {
      return reply.code(400).send({ ok: false, message: "invalid payload" });
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
    const profile = await ai.identifyProject(typeof payload.target === "string" ? payload.target : undefined);
    if (!profile) {
      return reply.code(404).send({ ok: false, message: "project not identified" });
    }
    return {
      ok: true,
      profile,
    };
  });

  server.get("/ai/project/profile", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = String(query.projectId || "");
    if (!projectId) {
      return reply.code(400).send({ ok: false, message: "projectId is required" });
    }
    const profile = ai.projectProfile(projectId);
    if (!profile) {
      return reply.code(404).send({ ok: false, message: "project profile not found" });
    }
    return { ok: true, profile };
  });

  server.get("/ai/project/history", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = String(query.projectId || "");
    if (!projectId) {
      return reply.code(400).send({ ok: false, message: "projectId is required" });
    }
    return { ok: true, history: ai.projectHistory(projectId) };
  });

  server.get("/ai/project/memory", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = String(query.projectId || "");
    if (!projectId) {
      return reply.code(400).send({ ok: false, message: "projectId is required" });
    }
    const memory = ai.projectMemory(projectId);
    if (!memory) {
      return reply.code(404).send({ ok: false, message: "project memory not found" });
    }
    return { ok: true, memory };
  });

  server.get("/ai/web/project-check", async () => {
    return {
      ok: true,
      report: await ai.inspectWebProject(),
    };
  });

  server.get("/ai/miniapp/project-check", async () => {
    return {
      ok: true,
      report: await ai.inspectMiniappProject(),
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/timeline", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ ok: false, message: "run not found", timeline: [] });
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
      return reply.code(404).send({ ok: false, message: "run not found" });
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
      return reply.code(404).send({ ok: false, message: "run not found", incidents: [] });
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
      return reply.code(404).send({ ok: false, message: "run not found", events: [] });
    }
    const query = request.query as Record<string, unknown>;
    const fingerprint = String(query.fingerprint || "");
    if (!fingerprint) {
      return reply.code(400).send({ ok: false, message: "fingerprint is required", events: [] });
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
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return {
      ok: true,
      flow,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/diagnosis", async (request, reply) => {
    const diagnosis = ai.runDiagnosis(request.params.runId);
    if (!diagnosis) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return {
      ok: true,
      diagnosis,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/closure", async (request, reply) => {
    const closure = ai.runClosure(request.params.runId);
    if (!closure) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return {
      ok: true,
      closure,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/integrity", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return {
      ok: true,
      integrity: ai.runIntegrity(request.params.runId),
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/readiness", async (request, reply) => {
    const readiness = ai.runReadiness(request.params.runId);
    if (!readiness) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return {
      ok: true,
      readiness,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/report", async (request, reply) => {
    const report = ai.runReport(request.params.runId);
    if (!report) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return {
      ok: true,
      report,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/driver-check", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const report = ai.runDriverCheck(request.params.runId, typeof query.driver === "string" ? query.driver : undefined);
    if (!report) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return {
      ok: true,
      driverCheck: report,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/failure-chain", async (request, reply) => {
    const chain = ai.runFailureChain(request.params.runId);
    if (!chain) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return { ok: true, failureChain: chain };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/repair-strategy", async (request, reply) => {
    const strategy = ai.runRepairStrategy(request.params.runId);
    if (!strategy) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return { ok: true, repairStrategy: strategy };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/handoff", async (request, reply) => {
    const handoff = ai.runHandoff(request.params.runId);
    if (!handoff) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return { ok: true, handoff };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/miniapp-signals", async (request, reply) => {
    const report = ai.runMiniappSignals(request.params.runId);
    if (!report) {
      return reply.code(404).send({ ok: false, message: "miniapp run not found" });
    }
    return { ok: true, miniappSignals: report };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/collection", async (request, reply) => {
    const report = ai.runCollection(request.params.runId);
    if (!report) {
      return reply.code(404).send({ ok: false, message: "run not found" });
    }
    return {
      ok: true,
      collection: report,
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/hotspots", async (request, reply) => {
    const run = engine.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ ok: false, message: "run not found", hotspots: [] });
    }
    return {
      ok: true,
      hotspots: ai.runHotspots(request.params.runId),
    };
  });

  server.get<{ Params: { runId: string } }>("/ai/run/:runId/repair-brief", async (request, reply) => {
    const brief = ai.runRepairBrief(request.params.runId);
    if (!brief) {
      return reply.code(404).send({ ok: false, message: "run not found" });
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
      return reply.code(404).send({
        ok: false,
        message: error instanceof Error ? error.message : "artifact unavailable",
      });
    }
  });

  server.get<{ Params: { id: string } }>("/ai/autoloop/:id", async (request, reply) => {
    const autoloop = ai.autoloop(request.params.id);
    if (!autoloop) {
      return reply.code(404).send({ ok: false, message: "autoloop not found" });
    }
    return {
      ok: true,
      autoloop,
    };
  });

  server.get<{ Params: { id: string } }>("/ai/autoloop/:id/decision", async (request, reply) => {
    const decision = ai.autoloopDecision(request.params.id);
    if (!decision) {
      return reply.code(404).send({ ok: false, message: "autoloop not found" });
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

  server.get("/ai/context", async (request) => {
    const query = request.query as Record<string, unknown>;
    const fingerprint = String(query.fingerprint || "");
    if (!fingerprint) {
      return {
        ok: false,
        message: "fingerprint is required",
        events: [],
      };
    }
    const before = clampInt(query.before, config.contextWindowSize, 0, 500);
    const after = clampInt(query.after, config.contextWindowSize, 0, 500);
    return {
      ok: true,
      ...ai.context(fingerprint, before, after),
    };
  });

  server.get("/ai/diff", async (request) => {
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
      return {
        ok: false,
        message: "baseline/current or baselineRunId/currentRunId are required",
        changed: [],
      };
    }
    return {
      ok: true,
      ...ai.diff(baseline, current),
    };
  });

  return server;
}
