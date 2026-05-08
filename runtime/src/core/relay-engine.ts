import path from "node:path";
import type { RelayConfig } from "../config.js";
import type {
  AutoloopAttemptCompleteInput,
  AutoloopAttemptStartInput,
  AutoloopStopDecision,
  AutoloopStartInput,
  BugCollectionReport,
    CheckpointInput,
    ClosureEvidenceReport,
    ClosureVerdict,
    DiagnosisArtifact,
    DriverAgnosticContract,
    DriverContractComplianceReport,
    EndRunInput,
  EndStepInput,
  ExternalDriverType,
  HandoffArtifact,
  IntegrityReport,
  MiniappIntegrationReport,
  MiniappProjectIntegrationReport,
  MiniappSignalReport,
  OrchestrationStartInput,
  ProjectKnowledgeSnapshot,
  ProjectMemoryRecord,
  ProjectProfile,
  RelayIncident,
  RelayLogEvent,
  RelayLogInput,
  RelaySnapshot,
  RepairBrief,
  RepairOutcome,
  RuntimeRelayReadinessReport,
  RootCauseHint,
  RunCheckpoint,
  RunClosure,
  RunDiagnosis,
  RunDiffItem,
  RunFailureChain,
  RunFlow,
  RunRepairStrategy,
  RunSummary,
  StartRunInput,
  StartStepInput,
  SupportedTarget,
  TestRun,
    TargetCapabilityReport,
    TaskEnforcementReport,
    TriggerDecisionReport,
    TriggerPhase,
  TimelineHotspot,
  TimelineItem,
  WebIntegrationReport,
} from "../types.js";
import { normalizeInput } from "./normalizer.js";
import { PriorityQueue } from "./priority-queue.js";
import { IncidentStore } from "./incident-store.js";
import { EventStore } from "./event-store.js";
import { RunStore } from "./run-store.js";
import { OrchestrationStore } from "./orchestration-store.js";
import { AutoloopStore } from "./autoloop-store.js";
import { writeArtifact } from "./artifact.js";
import { ProjectInspector } from "./project-inspector.js";
import { ProjectMemoryStore } from "./project-memory-store.js";

interface IngestResult {
  accepted: boolean;
  dropped: boolean;
  reason?: string;
  eventId?: string;
  lateEvent?: boolean;
}

function startWindowIso(windowMinutes: number): string {
  return new Date(Date.now() - Math.max(1, windowMinutes) * 60_000).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeStepName(step: RunDiagnosis["dominantFailureStep"]): string {
  return step ? step.name : "unscoped";
}

const SUPPORTED_TARGETS: SupportedTarget[] = ["web", "miniapp"];

export class RelayEngine {
  private readonly queue: PriorityQueue;
  private readonly events: EventStore;
  private readonly incidents: IncidentStore;
  private readonly runs: RunStore;
  private readonly orchestrations: OrchestrationStore;
  private readonly autoloops: AutoloopStore;
  private readonly inspector: ProjectInspector;
  private readonly projectMemory: ProjectMemoryStore;
  private readonly snapshots = new Map<string, RelaySnapshot>();
  private readonly snapshotOrder: string[] = [];

  constructor(private readonly config: RelayConfig) {
    this.queue = new PriorityQueue(config.maxPendingEvents);
    this.events = new EventStore(config.maxBufferedEvents);
    this.incidents = new IncidentStore();
    this.runs = new RunStore();
    this.orchestrations = new OrchestrationStore(config.artifactDir);
    this.autoloops = new AutoloopStore();
    this.inspector = new ProjectInspector(process.cwd());
    this.projectMemory = new ProjectMemoryStore(config.projectMemoryDir);
    void this.projectMemory.loadAll();
  }

  startRun(input: StartRunInput): TestRun {
    return this.runs.startRun(input);
  }

  startOrchestration(input: OrchestrationStartInput) {
    const run = this.runs.startRun(input);
    const session = this.orchestrations.start(run.id, input, run.target);
    return { run, session };
  }

  startAutoloop(input: AutoloopStartInput) {
    const { run, session: orchestration } = this.startOrchestration({
      label: input.triggerReason ? `autoloop:${input.triggerReason}` : "autoloop",
      target: input.target,
      scenario: input.scenario,
      baselineRunId: input.baselineRunId,
      metadata: input.entryContext,
    });
    const session = this.autoloops.start(run.id, input, run.target);
    return { run, orchestration, session };
  }

  startAutoloopAttempt(sessionId: string, input: AutoloopAttemptStartInput) {
    const session = this.autoloops.getById(sessionId);
    if (!session) {
      return null;
    }
    const attempt = this.autoloops.startAttempt(sessionId, input);
    if (attempt) {
      this.autoloops.setStatus(sessionId, "diagnosing");
    }
    return attempt;
  }

  completeAutoloopAttempt(sessionId: string, attemptId: string, input: AutoloopAttemptCompleteInput) {
    const attempt = this.autoloops.completeAttempt(sessionId, attemptId, input);
    if (!attempt) {
      return null;
    }
    const decision = this.getAutoloopDecision(sessionId);
    if (decision) {
      this.autoloops.setStatus(sessionId, decision.shouldContinue ? "retesting" : decision.status === "resolved" ? "resolved" : "halted");
    }
    return { attempt, decision };
  }

  recordRepairOutcome(sessionId: string, attemptId: string, outcome: RepairOutcome) {
    const stored = this.autoloops.setRepairOutcome(sessionId, attemptId, outcome);
    if (!stored) {
      return null;
    }
    this.autoloops.setStatus(sessionId, "repairing");
    return stored;
  }

  addCheckpoint(runId: string, input: CheckpointInput): RunCheckpoint | null {
    const run = this.runs.getRun(runId);
    if (!run) {
      return null;
    }
    if (input.stepId && !this.runs.getStep(runId, input.stepId)) {
      return null;
    }
    return this.orchestrations.addCheckpoint(runId, input);
  }

  endRun(runId: string, input: EndRunInput): TestRun | null {
    const run = this.runs.endRun(runId, input);
    if (run) {
      void this.syncProjectMemoryForRun(run.id);
    }
    return run;
  }

  startStep(runId: string, input: StartStepInput) {
    return this.runs.startStep(runId, input, this.events.assignSequence());
  }

  endStep(runId: string, stepId: string, input: EndStepInput) {
    return this.runs.endStep(runId, stepId, input, this.events.assignSequence());
  }

  ingest(input: RelayLogInput): IngestResult {
    if (!this.isValidInput(input)) {
      return { accepted: false, dropped: true, reason: "invalid_payload" };
    }
    if (input.stepId && !input.runId) {
      return { accepted: false, dropped: true, reason: "step_requires_run" };
    }
    if (!this.config.includeDebug && input.level === "debug") {
      return { accepted: false, dropped: true, reason: "debug_disabled" };
    }
    if (input.runId && !this.runs.getRun(input.runId)) {
      return { accepted: false, dropped: true, reason: "invalid_run" };
    }
    if (input.runId && input.stepId && !this.runs.getStep(input.runId, input.stepId)) {
      return { accepted: false, dropped: true, reason: "invalid_step" };
    }
    const run = input.runId ? this.runs.getRun(input.runId) : null;
    const lateEvent = Boolean(run && run.status !== "running");
    const event = normalizeInput(input, this.events.assignSequence(), lateEvent);
    const accepted = this.queue.enqueue(event);
    if (!accepted) {
      return { accepted: false, dropped: true, reason: "queue_backpressure" };
    }
    this.drainQueue();
    return { accepted: true, dropped: false, eventId: event.id, lateEvent };
  }

  ingestBatch(inputs: RelayLogInput[], binding?: { runId?: string; stepId?: string }): { accepted: number; dropped: number } {
    let accepted = 0;
    let dropped = 0;
    for (const record of inputs) {
      const result = this.ingest({
        ...record,
        runId: record.runId || binding?.runId,
        stepId: record.stepId || binding?.stepId,
      });
      if (result.accepted) {
        accepted += 1;
      } else {
        dropped += 1;
      }
    }
    return { accepted, dropped };
  }

  listRuns(filters: { limit: number; status?: TestRun["status"]; target?: TestRun["target"] }) {
    const runs = this.runs.listRuns(filters);
    return runs.map((run) => ({
      run,
      orchestration: this.orchestrations.getSession(run.id),
      autoloop: this.autoloops.getByRunId(run.id),
      summary: this.listRunSummary(run.id),
      integrity: this.listRunIntegrity(run.id),
    }));
  }

  listRunTimeline(runId: string, options: { cursor?: number; limit?: number; level?: RelayLogEvent["level"] }): TimelineItem[] {
    const run = this.runs.getRun(runId);
    if (!run) {
      return [];
    }
    const steps = this.runs.listSteps(runId);
    const events = this.events.listByRun(runId);
    const highlightedSequences = new Set<number>();
    if (!options.level) {
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event.level === "error" || event.level === "warn") {
          highlightedSequences.add(event.sequence);
          if (events[index - 1]) highlightedSequences.add(events[index - 1].sequence);
          if (events[index + 1]) highlightedSequences.add(events[index + 1].sequence);
        }
        if (event.phase === "network" || event.phase === "navigation" || event.phase === "lifecycle") {
          highlightedSequences.add(event.sequence);
        }
      }
    }

    const rawItems: TimelineItem[] = [];
    for (const step of steps) {
      rawItems.push({
        type: "step_boundary",
        sequence: step.startedSequence,
        timestamp: step.startedAt,
        runId,
        stepId: step.id,
        action: "step_started",
        step,
      });
      if (step.endedSequence > 0) {
        rawItems.push({
          type: "step_boundary",
          sequence: step.endedSequence,
          timestamp: step.endedAt || step.startedAt,
          runId,
          stepId: step.id,
          action: "step_ended",
          step,
        });
      }
    }
    for (const event of events) {
      if (options.level && !this.matchesLevel(event.level, options.level)) continue;
      if (!options.level && event.phase === "log" && !highlightedSequences.has(event.sequence) && event.level === "debug") continue;
      if (!options.level && event.phase === "log" && !highlightedSequences.has(event.sequence) && event.level === "info") continue;
      rawItems.push(this.toTimelineItem(event, runId));
    }
    const cursor = Number.isFinite(options.cursor) ? Number(options.cursor) : 0;
    const limit = Math.max(1, options.limit || this.config.contextWindowSize);
    return rawItems.filter((item) => item.sequence > cursor).sort((a, b) => a.sequence - b.sequence).slice(0, limit);
  }

  listRunSummary(runId: string): RunSummary {
    const run = this.runs.getRun(runId);
    const events = this.events.listByRun(runId);
    const previousRunId = this.resolveBaselineRunId(runId);
    const topErrors = this.incidents.listTop({ runId, limit: 10, previousRunId });
    const diffs = previousRunId ? this.diffRuns(previousRunId, runId).changed : [];
    return {
      runId,
      totalEvents: events.length,
      errorCount: events.filter((event) => event.level === "error").length,
      warnCount: events.filter((event) => event.level === "warn").length,
      incidentCount: this.incidents.listFingerprintsForRun(runId).length,
      newIncidents: diffs.filter((item) => item.status === "new").length,
      regressedIncidents: diffs.filter((item) => item.status === "regressed").length,
      resolvedIncidents: diffs.filter((item) => item.status === "resolved").length,
      status: run ? run.status : "aborted",
      topErrors,
    };
  }

  listRunIncidents(runId: string, limit: number): RelayIncident[] {
    return this.incidents.listTop({ runId, limit, previousRunId: this.resolveBaselineRunId(runId) });
  }

  listRunContext(runId: string, fingerprint: string, before: number, after: number): RelayLogEvent[] {
    const latestId = this.incidents.getLatestEventId(fingerprint, runId);
    if (!latestId) {
      return [];
    }
    return this.events.aroundEvent(latestId, before, after, runId);
  }

  listRunFlow(runId: string): RunFlow | null {
    const run = this.runs.getRun(runId);
    if (!run) return null;
    const runIncidents = this.listRunIncidents(runId, 20);
    const steps = this.runs.listSteps(runId).map((step) => {
      const events = this.events.listByStep(runId, step.id);
      return {
        step,
        counts: {
          totalEvents: events.length,
          errors: events.filter((event) => event.level === "error").length,
          warns: events.filter((event) => event.level === "warn").length,
        },
        topIncidents: runIncidents.filter((incident) => events.some((event) => event.fingerprint === incident.fingerprint)).slice(0, 3),
      };
    });
    return { run, steps };
  }

  listRunIntegrity(runId: string): IntegrityReport {
    const run = this.runs.getRun(runId);
    const steps = this.runs.listSteps(runId);
    const events = this.events.listByRun(runId);
    const hasStepBoundaries = steps.length > 0 && steps.some((step) => step.endedSequence > 0 || step.startedSequence > 0);
    const hasNetworkSignals = events.some((event) => event.phase === "network");
    const hasRouteSignals = events.some((event) => event.phase === "navigation" || Boolean(event.route));
    const hasLifecycleSignals = events.some((event) => event.phase === "lifecycle");
    const hasRenderSignals = events.some((event) => event.phase === "render" || event.tags.includes("render_complete"));
    const hasResourceSignals = events.some((event) => event.phase === "resource");
    const hasErrorsOrAssertions = events.some((event) => event.level === "error" || event.level === "warn") || steps.some((step) => step.kind === "assert");
    const warnings: string[] = [];
    if (!hasStepBoundaries) warnings.push("missing_step_boundaries");
    if (!hasNetworkSignals) warnings.push("missing_network_signals");
    if (!hasRouteSignals) warnings.push("missing_route_signals");
    if (!hasLifecycleSignals && run?.target === "miniapp") warnings.push("missing_lifecycle_signals");
    if (!hasRenderSignals && run?.target === "web") warnings.push("missing_render_signals");
    if (!hasErrorsOrAssertions) warnings.push("missing_errors_or_assertions");
    const checks = [hasStepBoundaries, hasNetworkSignals, hasRouteSignals, hasLifecycleSignals || run?.target !== "miniapp", hasRenderSignals || run?.target !== "web", hasErrorsOrAssertions];
    const integrityScore = Math.round((checks.filter(Boolean).length / checks.length) * 100);
    const capturedCapabilities = [
      hasStepBoundaries ? "step-boundary" : "",
      hasNetworkSignals ? "network" : "",
      hasRouteSignals ? "route" : "",
      hasLifecycleSignals ? "lifecycle" : "",
      hasRenderSignals ? "render" : "",
      hasResourceSignals ? "resource" : "",
      hasErrorsOrAssertions ? "error-or-assertion" : "",
    ].filter(Boolean);
    return {
      runId,
      hasStepBoundaries,
      hasNetworkSignals,
      hasRouteSignals,
      hasLifecycleSignals,
      hasRenderSignals,
      hasResourceSignals,
      hasErrorsOrAssertions,
      integrityScore,
      warnings,
      capturedCapabilities,
    };
  }

  getTargetSupport(target: string): TargetCapabilityReport {
    const normalized = String(target || "").trim().toLowerCase();
    if (normalized === "web") {
      return {
        target: "web",
        status: "supported",
        driverAvailable: true,
        sdkAvailable: true,
        signalReadiness: "ready",
        reasonCode: "web_supported",
        reason: "Web projects support the full local closed-loop flow with Playwright-driven retest.",
        recommendedAction: "Use relay autoloop run for full closed-loop verification.",
        supportedTargets: SUPPORTED_TARGETS,
        currentCapabilities: ["playwright-driver", "web-sdk", "timeline", "diagnosis", "closure", "autoloop"],
        recommendedIntegrationMode: "browser-injected",
        evidenceSource: "runtime_relay",
      };
    }
    if (normalized === "miniapp") {
      return {
        target: "miniapp",
        status: "partial",
        driverAvailable: false,
        sdkAvailable: true,
        signalReadiness: "verify_required",
        reasonCode: "miniapp_verify_required",
        reason: "Miniapp projects support integration verification and diagnostic collection, but not full automatic driving.",
        recommendedAction: "Run relay miniapp verify before any diagnosis or repair decision.",
        supportedTargets: SUPPORTED_TARGETS,
        currentCapabilities: ["miniapp-sdk", "integration-verify", "collection", "integrity", "diagnosis"],
        recommendedIntegrationMode: "wrapper-first",
        evidenceSource: "runtime_relay",
      };
    }
    if (normalized === "backend") {
      return {
        target: "backend",
        status: "inapplicable",
        driverAvailable: false,
        sdkAvailable: true,
        signalReadiness: "unsupported",
        reasonCode: "backend_auxiliary_only",
        reason: "Backend relay is only an auxiliary signal source and is not a standalone closed-loop target.",
        recommendedAction: "Use backend relay only together with a web or miniapp target.",
        supportedTargets: SUPPORTED_TARGETS,
        currentCapabilities: ["manual-send", "auxiliary-relay"],
        recommendedIntegrationMode: "manual-fallback",
        evidenceSource: "runtime_relay",
      };
    }
    return {
      target: normalized || "unknown",
      status: "unsupported",
      driverAvailable: false,
      sdkAvailable: false,
      signalReadiness: "unsupported",
      reasonCode: "unsupported_target",
      reason: "This target is outside the supported scope of the skill.",
      recommendedAction: "Use the skill only for browser web projects or WeChat miniapp projects.",
      supportedTargets: SUPPORTED_TARGETS,
      currentCapabilities: [],
      recommendedIntegrationMode: "manual-fallback",
      evidenceSource: "runtime_relay",
    };
  }

  getWebIntegrationGuide() {
    const support = this.getTargetSupport("web");
    return {
      target: "web",
      evidenceSource: "runtime_relay" as const,
      recommendedIntegrationModes: ["bootstrap", "browser-injected", "manual"],
      recommendedMode: "browser-injected",
      requiredSignals: ["console", "error", "network_or_route", "render", "step_boundary"],
      bestPractice: "Prefer runtime relay instrumentation over scraping browser devtools console UI.",
      support,
    };
  }

  getMiniappIntegrationGuide() {
    const support = this.getTargetSupport("miniapp");
    return {
      target: "miniapp",
      evidenceSource: "runtime_relay" as const,
      recommendedIntegrationModes: ["wrapper-first", "patch-enhanced", "manual-fallback"],
      recommendedMode: "wrapper-first",
      requiredSignals: ["console", "lifecycle", "route_or_network", "step_boundary"],
      bestPractice: "Prefer wrapper-first runtime relay instrumentation over tool-console observation.",
      support,
    };
  }

  getDriverContract(target: string, driver: string): DriverAgnosticContract {
    const normalizedTarget = (target === "miniapp" ? "miniapp" : "web") as SupportedTarget;
    const normalizedDriver = (
      driver === "playwright" || driver === "computer-use" || driver === "ide-agent" || driver === "generic-browser-agent"
        ? driver
        : normalizedTarget === "web"
          ? "generic-browser-agent"
          : "ide-agent"
    ) as ExternalDriverType;
    return {
      target: normalizedTarget,
      driver: normalizedDriver,
      positioning: normalizedDriver === "playwright" ? "reference_driver" : "external_agent_driver",
      requiredOrder:
        normalizedTarget === "web"
          ? [
              "doctor target",
              "project verify",
              "runs/orchestrations start",
              "bind run and step in web relay",
              "drive page actions",
              "query collection and diagnosis",
              "query closure",
              "query handoff on failure",
            ]
          : [
              "doctor target",
              "project verify",
              "runs/orchestrations start",
              "bind run and step in miniapp relay",
              "drive or observe miniapp actions",
              "query collection and diagnosis",
              "query closure-readiness and handoff",
            ],
      requiredApiCalls:
        normalizedTarget === "web"
          ? [
              "POST /ai/project/identify",
              "GET /ai/web/project-check",
              "POST /orchestrations/start",
              "POST /runs/:runId/steps/start",
              "GET /ai/run/:runId/collection",
              "GET /ai/run/:runId/diagnosis",
              "GET /ai/run/:runId/closure",
              "GET /ai/run/:runId/handoff",
            ]
          : [
              "POST /ai/project/identify",
              "GET /ai/miniapp/project-check",
              "POST /orchestrations/start",
              "POST /runs/:runId/steps/start",
              "GET /ai/run/:runId/collection",
              "GET /ai/run/:runId/diagnosis",
              "GET /ai/run/:runId/miniapp-signals",
              "GET /ai/run/:runId/handoff",
            ],
      requiredSignals:
        normalizedTarget === "web"
          ? ["console", "error", "route_or_network", "render", "step_boundary"]
          : ["console", "lifecycle", "route_or_network", "step_boundary"],
      sdkBindingContract: {
        mustBindRun: true,
        mustBindStep: true,
        preferredAdapters: normalizedTarget === "web" ? ["createWebRelay"] : ["createMiniappRelay"],
      },
      closureContract: {
        mustCheckCollection: true,
        mustCheckClosure: true,
        mustCheckHandoffOnFailure: true,
      },
      stopConditions: [
        "closure.decision.status === resolved",
        "collection.status === incomplete",
        "integrity or readiness below acceptable threshold",
        "regression detected",
        "max attempts reached",
      ],
      forbiddenClaims: [
        "Do not claim the project is verified before collection and closure are checked.",
        "Do not skip project verify for runtime work.",
        "Do not use DevTools console UI as the primary evidence chain.",
      ],
    };
  }

  getDriverContractCompliance(runId: string, driver?: string): DriverContractComplianceReport | null {
    const run = this.runs.getRun(runId);
    if (!run || (run.target !== "web" && run.target !== "miniapp")) return null;
    const metadataDriver = typeof run.metadata.driver === "string" ? String(run.metadata.driver) : "";
    const contract = this.getDriverContract(run.target, driver || metadataDriver || (run.target === "web" ? "computer-use" : "ide-agent"));
    const events = this.events.listByRun(runId);
    const runtimeEvents = events.filter((event) => event.phase !== "log" || event.level !== "debug");
    const runBoundEvents = runtimeEvents.filter((event) => event.runId === runId);
    const stepBoundEvents = runtimeEvents.filter((event) => event.stepId);
    const integrity = this.listRunIntegrity(runId);
    const collection = this.listRunCollection(runId);
    const closure = this.listRunClosure(runId);
    const missingRequirements: string[] = [];
    if (contract.sdkBindingContract.mustBindRun && runtimeEvents.length > 0 && runBoundEvents.length !== runtimeEvents.length) {
      missingRequirements.push("missing_run_binding");
    }
    if (contract.sdkBindingContract.mustBindStep && !integrity.hasStepBoundaries) {
      missingRequirements.push("missing_step_boundaries");
    }
    if (contract.sdkBindingContract.mustBindStep && stepBoundEvents.length === 0) {
      missingRequirements.push("missing_step_binding");
    }
    if (contract.requiredSignals.includes("render") && !integrity.hasRenderSignals) {
      missingRequirements.push("missing_render_signal");
    }
    if (contract.requiredSignals.includes("lifecycle") && !integrity.hasLifecycleSignals) {
      missingRequirements.push("missing_lifecycle_signal");
    }
    if (contract.requiredSignals.includes("step_boundary") && !integrity.hasStepBoundaries) {
      missingRequirements.push("missing_step_boundary_signal");
    }
    if (
      (contract.requiredSignals.includes("route_or_network") || contract.requiredSignals.includes("network_or_route")) &&
      !integrity.hasRouteSignals &&
      !integrity.hasNetworkSignals
    ) {
      missingRequirements.push("missing_route_or_network_signal");
    }
    if (contract.closureContract.mustCheckCollection && collection?.status === "incomplete") {
      missingRequirements.push("collection_incomplete");
    }
    if (contract.closureContract.mustCheckClosure && closure?.decision.status === "running") {
      missingRequirements.push("closure_not_available");
    }
    const observedSignals = [
      integrity.hasErrorsOrAssertions ? "error" : "",
      integrity.hasNetworkSignals ? "network" : "",
      integrity.hasRouteSignals ? "route" : "",
      integrity.hasLifecycleSignals ? "lifecycle" : "",
      integrity.hasRenderSignals ? "render" : "",
      integrity.hasStepBoundaries ? "step_boundary" : "",
    ].filter(Boolean);
    return {
      runId,
      target: run.target,
      driver: contract.driver,
      contract,
      compliant: missingRequirements.length === 0,
      missingRequirements,
      warnings: collection?.signalGaps || [],
      observedSignals,
      runBoundEventCoverage: runtimeEvents.length === 0 ? 0 : Math.round((runBoundEvents.length / runtimeEvents.length) * 100),
      stepBoundEventCoverage: runtimeEvents.length === 0 ? 0 : Math.round((stepBoundEvents.length / runtimeEvents.length) * 100),
    };
  }

  getTriggerDecision(input: { target: string; reason?: string; phase?: TriggerPhase; runtimeImpact?: boolean }): TriggerDecisionReport {
    const targetSupport = this.getTargetSupport(input.target);
    const phase = input.phase || "manual";
    const reason = String(input.reason || "").trim();
    const runtimeImpact = Boolean(input.runtimeImpact);
    const reasonText = reason.toLowerCase();
    const incidentLike =
      runtimeImpact ||
      phase === "self_test" ||
      phase === "retest" ||
      phase === "regression_check" ||
      phase === "incident_review" ||
      /报错|异常|白屏|修复失败|回归|测试|自测|复测|验证|closure|regression|error|bug|fail/.test(reasonText);

    if (targetSupport.status === "unsupported") {
      return {
        target: targetSupport.target,
        phase,
        reason,
        runtimeImpact,
        mustTrigger: false,
        status: "unsupported",
        reasonCode: targetSupport.reasonCode,
        decisionReason: targetSupport.reason,
        recommendedCommand: "",
        blockingReason: targetSupport.reason,
      };
    }
    if (targetSupport.status === "inapplicable") {
      return {
        target: targetSupport.target,
        phase,
        reason,
        runtimeImpact,
        mustTrigger: false,
        status: "inapplicable",
        reasonCode: targetSupport.reasonCode,
        decisionReason: targetSupport.reason,
        recommendedCommand: "",
        blockingReason: targetSupport.reason,
      };
    }
    if (targetSupport.target === "miniapp") {
      return {
        target: targetSupport.target,
        phase,
        reason,
        runtimeImpact,
        mustTrigger: incidentLike,
        status: incidentLike ? "must_trigger" : "optional",
        reasonCode: incidentLike ? "miniapp_verify_required" : "miniapp_optional_verify",
        decisionReason: incidentLike
          ? "Miniapp runtime work must enter verify-first flow before any closure claim."
          : "Miniapp work can stay idle until runtime validation is requested.",
        recommendedCommand: "relay miniapp verify",
        blockingReason: incidentLike ? "verify_required_before_repair" : "",
      };
    }
    return {
      target: targetSupport.target,
      phase,
      reason,
      runtimeImpact,
      mustTrigger: incidentLike,
      status: incidentLike ? "must_trigger" : "skip_allowed",
      reasonCode: incidentLike ? "web_autoloop_required" : "non_runtime_change",
      decisionReason: incidentLike
        ? "Web runtime work must enter the relay loop before closure can be claimed."
        : "This change does not appear to require a runtime validation loop.",
      recommendedCommand: incidentLike ? "relay autoloop run --target web" : "",
      blockingReason: incidentLike ? "closure_requires_autoloop" : "",
    };
  }

  listRunDiagnosis(runId: string): RunDiagnosis | null {
    const run = this.runs.getRun(runId);
    if (!run) return null;
    const incidents = this.listRunIncidents(runId, 5);
    const integrity = this.listRunIntegrity(runId);
    const events = this.events.listByRun(runId);
    const firstFailure = events.find((event) => event.level === "error");
    const dominantFailureStep = this.findDominantFailureStep(runId, incidents[0]?.fingerprint || "");
    const suspectedRootCauses = this.findRootCauses(runId, dominantFailureStep, firstFailure?.sequence || 0, incidents);
    const recommendedNextQueries = [
      `/ai/run/${runId}/timeline?limit=${this.config.contextWindowSize}`,
      incidents[0] ? `/ai/run/${runId}/context?fingerprint=${incidents[0].fingerprint}&before=${this.config.contextWindowSize}&after=${this.config.contextWindowSize}` : "",
      `/ai/run/${runId}/flow`,
      `/ai/run/${runId}/integrity`,
    ].filter(Boolean);
    return {
      runId,
      runStatus: run.status,
      dominantFailureStep,
      firstFailureSequence: firstFailure?.sequence || 0,
      topIncidents: incidents,
      suspectedRootCauses,
      missingSignals: integrity.warnings,
      recommendedNextQueries,
    };
  }

  listRunClosure(runId: string): RunClosure | null {
    const run = this.runs.getRun(runId);
    if (!run) return null;
    const baselineRunId = this.resolveBaselineRunId(runId);
    const summary = this.listRunSummary(runId);
    if (run.status === "running") {
      return {
        runId,
        baselineRunId,
        isResolved: false,
        hasRegression: false,
        newIncidentCount: 0,
        resolvedIncidentCount: 0,
        regressedIncidentCount: 0,
        confidence: 0.2,
        evidence: ["run_in_progress"],
        decision: { status: "running", confidence: 0.2, reason: "Run is still in progress." },
      };
    }
    if (!baselineRunId) {
      const isCleanPass = summary.errorCount === 0 && summary.incidentCount === 0 && run.status === "passed";
      const hasRuntimeFailure = run.status === "failed" || run.status === "aborted" || summary.errorCount > 0 || summary.incidentCount > 0;
      return {
        runId,
        baselineRunId: "",
        isResolved: isCleanPass,
        hasRegression: false,
        newIncidentCount: 0,
        resolvedIncidentCount: 0,
        regressedIncidentCount: 0,
        confidence: hasRuntimeFailure ? 0.72 : 0.45,
        evidence: [
          "missing_baseline",
          `run_status=${run.status}`,
          `error_count=${summary.errorCount}`,
          `incident_count=${summary.incidentCount}`,
        ],
        decision: hasRuntimeFailure
          ? {
              status: "unresolved",
              confidence: 0.72,
              reason: "No baseline run is available, but the current run still contains runtime failures.",
            }
          : {
              status: "inconclusive",
              confidence: 0.45,
              reason: "No baseline run is available for closure comparison.",
            },
      };
    }
    const diff = this.diffRuns(baselineRunId, runId).changed;
    const newIncidentCount = diff.filter((item) => item.status === "new").length;
    const resolvedIncidentCount = diff.filter((item) => item.status === "resolved").length;
    const regressedIncidentCount = diff.filter((item) => item.status === "regressed").length;
    const hasRegression = regressedIncidentCount > 0 || diff.some((item) => item.status === "unchanged-increased");
    const isResolved = !hasRegression && summary.errorCount === 0 && summary.incidentCount === 0 && run.status === "passed";
    const decision = this.classifyClosure(run, summary, diff, isResolved, hasRegression);
    return {
      runId,
      baselineRunId,
      isResolved,
      hasRegression,
      newIncidentCount,
      resolvedIncidentCount,
      regressedIncidentCount,
      confidence: decision.confidence,
      evidence: [
        `run_status=${run.status}`,
        `error_count=${summary.errorCount}`,
        `incident_count=${summary.incidentCount}`,
        `resolved=${resolvedIncidentCount}`,
        `regressed=${regressedIncidentCount}`,
      ],
      decision,
    };
  }

  listRunCollection(runId: string): BugCollectionReport | null {
    const run = this.runs.getRun(runId);
    if (!run) return null;
    const integrity = this.listRunIntegrity(runId);
    const topIncidents = this.listRunIncidents(runId, 5);
    const timelineHotSpots = this.listRunHotspots(runId).slice(0, 8);
    const firstFailure = timelineHotSpots[0] || null;
    const signalGaps = this.getCollectionSignalGaps(runId, integrity);
    const recommendedCollectionFixes = signalGaps.map((warning) => {
      if (warning === "missing_step_boundaries") return "Add run step boundaries before diagnosing business failures.";
      if (warning === "missing_network_signals") return "Instrument request lifecycle before continuing.";
      if (warning === "missing_route_signals") return "Capture route transitions or route metadata.";
      if (warning === "missing_route_or_network_signals") return "Capture at least one of route or network signals before closure decisions.";
      if (warning === "missing_lifecycle_signals") return "Wrap page/app/component lifecycle hooks.";
      return "Collect stronger assertion or error signals.";
    });
    return {
      runId,
      status: signalGaps.length > 0 ? "incomplete" : "complete",
      integrity,
      timelineHotSpots,
      topIncidents,
      firstFailure,
      signalGaps,
      recommendedCollectionFixes,
    };
  }

  getRunReadiness(runId: string): RuntimeRelayReadinessReport | null {
    const run = this.runs.getRun(runId);
    if (!run) return null;
    const integrity = this.listRunIntegrity(runId);
    const collection = this.listRunCollection(runId);
    const targetSupport = this.getTargetSupport(run.target);
    const requiredSignals =
      run.target === "miniapp"
        ? ["console", "lifecycle", "route_or_network", "step_boundary"]
        : ["console", "error", "network_or_route", "render", "step_boundary"];
    const availableSignals = [
      "console",
      integrity.hasErrorsOrAssertions ? "error" : "",
      integrity.hasNetworkSignals ? "network" : "",
      integrity.hasRouteSignals ? "route" : "",
      integrity.hasLifecycleSignals ? "lifecycle" : "",
      integrity.hasRenderSignals ? "render" : "",
      integrity.hasResourceSignals ? "resource" : "",
      integrity.hasStepBoundaries ? "step_boundary" : "",
    ].filter(Boolean);
    const missingSignals = collection?.signalGaps || [];
    const bestPracticeCompliant =
      targetSupport.status === "supported" &&
      missingSignals.length === 0 &&
      (run.target !== "web" || Boolean(integrity.hasRenderSignals));
    const maturity =
      availableSignals.length <= 1
        ? "none"
        : bestPracticeCompliant && integrity.hasNetworkSignals && integrity.hasRouteSignals
          ? "strong"
          : missingSignals.length === 0
            ? "preferred"
            : "basic";
    return {
      target: run.target,
      maturity,
      evidenceSource: "runtime_relay",
      evidenceLevel: "runtime_verified",
      requiredSignals,
      availableSignals,
      missingSignals,
      autoloopEligible: run.target === "web" && bestPracticeCompliant,
      blockingReasons: [
        ...(targetSupport.status === "supported" ? [] : [targetSupport.reasonCode]),
        ...missingSignals,
      ],
      recommendedIntegrationMode: run.target === "web" ? "browser-injected" : "wrapper-first",
      bestPracticeCompliant,
      verifiedRunId: runId,
    };
  }

  getRunReport(runId: string): ClosureEvidenceReport | null {
    const run = this.runs.getRun(runId);
    if (!run) return null;
    const support = this.getTargetSupport(run.target);
    const runtimeReadiness = this.getRunReadiness(runId);
    const driverCheck = this.getDriverContractCompliance(runId);
    const collection = this.listRunCollection(runId);
    const diagnosis = this.listRunDiagnosis(runId);
    const closure = this.listRunClosure(runId);
    const project = this.resolveProjectProfileForRun(runId);
    const triggerDecision = this.getTriggerDecision({
      target: run.target,
      phase: run.status === "running" ? "manual" : "retest",
      runtimeImpact: true,
      reason: run.label,
    });
    const projectVerifyMode = runtimeReadiness?.evidenceLevel === "runtime_verified" ? "runtime_verified" : "project_only";
    const projectBlockingReasons = [
      ...(support.status === "supported" ? [] : [support.reasonCode]),
      ...(runtimeReadiness?.blockingReasons || []),
    ];
    const verdict = this.buildClosureVerdict(runId, support, runtimeReadiness, driverCheck, collection, closure);
    return {
      runId,
      target: run.target,
      support,
      triggerDecision,
      projectVerify: {
        mode: projectVerifyMode,
        projectId: project?.projectId || "",
        status: support.status,
        closureEligible: Boolean(runtimeReadiness?.bestPracticeCompliant && collection?.status === "complete" && closure?.decision.status === "resolved"),
        autoloopEligible: Boolean(runtimeReadiness?.autoloopEligible),
        blockingReasons: projectBlockingReasons,
        recommendedAction:
          runtimeReadiness?.evidenceLevel === "runtime_verified"
            ? verdict.nextAction
            : support.target === "miniapp"
              ? "Run miniapp verify and a real run before claiming closure."
              : "Run a real web flow and fetch run-scoped readiness before claiming closure.",
      },
      runtimeReadiness,
      driverCheck,
      collection,
      diagnosis,
      closure,
      handoff: verdict.status === "resolved" ? null : this.getRunHandoff(runId),
      verdict,
    };
  }

  getTaskEnforcement(input: {
    target: string;
    phase?: TriggerPhase;
    runtimeImpact?: boolean;
    runId?: string;
    closureClaim?: boolean;
  }): TaskEnforcementReport {
    const target = String(input.target || "");
    const support = this.getTargetSupport(target);
    const triggerDecision = this.getTriggerDecision({
      target,
      phase: input.phase,
      runtimeImpact: input.runtimeImpact,
      reason: input.closureClaim ? "closure_claim" : "",
    });
    const report = input.runId ? this.getRunReport(input.runId) : null;
    const requiredEvidence =
      target === "miniapp"
        ? ["project_verify", "runtime_readiness", "collection", "diagnosis", "closure_or_handoff"]
        : ["project_verify", "runtime_readiness", "collection", "diagnosis", "closure"];
    const blockingReasons: string[] = [];
    if (support.status === "unsupported" || support.status === "inapplicable") {
      blockingReasons.push(support.reasonCode);
    }
    if (triggerDecision.mustTrigger && !input.runId) {
      blockingReasons.push("missing_run_evidence");
    }
    if (input.closureClaim) {
      if (!report) {
        blockingReasons.push("missing_closure_report");
      } else if (report.verdict.status !== "resolved") {
        blockingReasons.push(`verdict:${report.verdict.status}`);
      }
    }
    if (report?.runtimeReadiness?.evidenceLevel === "project_only") {
      blockingReasons.push("runtime_unverified");
    }
    if (report?.collection?.status === "incomplete") {
      blockingReasons.push("collection_incomplete");
    }
    const recommendedCommand =
      target === "miniapp"
        ? "relay miniapp verify"
        : triggerDecision.mustTrigger
          ? "relay autoloop run --target web"
          : "relay project verify --target web";
    return {
      target,
      phase: input.phase || "manual",
      runtimeImpact: Boolean(input.runtimeImpact),
      closureClaim: Boolean(input.closureClaim),
      mustUseSkill: triggerDecision.mustTrigger,
      canClaimDone: Boolean(input.closureClaim ? report?.verdict.status === "resolved" : report?.verdict.status === "resolved"),
      blockingReasons,
      requiredEvidence,
      recommendedCommand,
    };
  }

  listRunHotspots(runId: string): TimelineHotspot[] {
    const items = this.listRunTimeline(runId, { limit: Math.max(200, this.config.contextWindowSize * 4), level: "info" });
    return items
      .map((item): TimelineHotspot | null => {
        if (item.type === "incident_marker") {
          return {
            sequence: item.sequence,
            type: item.type,
            message: item.incident.sampleMessage || item.event.message,
            fingerprint: item.incident.fingerprint,
          };
        }
        if (
          item.type === "network_event" ||
          item.type === "lifecycle_event" ||
          item.type === "resource_event" ||
          item.type === "render_event" ||
          item.type === "runtime_guard_event" ||
          item.type === "log_event"
        ) {
          const message = "event" in item ? item.event.message : "";
          const interesting = "event" in item && (item.event.level === "error" || item.event.level === "warn" || item.event.phase !== "log");
          if (!interesting) return null;
          return {
            sequence: item.sequence,
            type: item.type,
            message,
            fingerprint: "event" in item ? item.event.fingerprint : "",
          };
        }
        return null;
      })
      .filter((item): item is TimelineHotspot => Boolean(item))
      .sort((a, b) => a.sequence - b.sequence);
  }

  getRepairBrief(runId: string): RepairBrief | null {
    const diagnosis = this.listRunDiagnosis(runId);
    if (!diagnosis) return null;
    const run = this.runs.getRun(runId);
    if (!run) return null;
    const autoloop = this.autoloops.getByRunId(runId);
    const latestAttempt = autoloop ? this.autoloops.listAttempts(autoloop.id).at(-1) || null : null;
    const integrity = this.listRunIntegrity(runId);
    const collection = this.listRunCollection(runId);
    const targetSupport = this.getTargetSupport(run.target);
    const driverCheck = this.getDriverContractCompliance(runId);
    const blockingReasons = [
      ...(targetSupport.status !== "supported" ? [targetSupport.reasonCode] : []),
      ...(collection?.signalGaps || []),
      ...(!diagnosis.dominantFailureStep ? ["missing_dominant_failure_step"] : []),
      ...(driverCheck && !driverCheck.compliant ? driverCheck.missingRequirements : []),
    ];
    const closure = this.listRunClosure(runId);
    const repairScope =
      blockingReasons.length > 0
        ? "integration_first"
        : closure?.hasRegression
          ? "regression_containment"
          : diagnosis.topIncidents.length === 0 && !diagnosis.dominantFailureStep
            ? "evidence_insufficient"
            : "runtime_bug_fix";
    const targetFilesHint = [
      diagnosis.dominantFailureStep ? `step:${diagnosis.dominantFailureStep.name}` : "",
      ...diagnosis.topIncidents.slice(0, 3).map((incident) => `fingerprint:${incident.fingerprint}`),
      diagnosis.missingSignals.some((signal) => signal.includes("lifecycle")) ? "miniapp-adapter" : "",
      diagnosis.missingSignals.some((signal) => signal.includes("network")) ? "network-instrumentation" : "",
      diagnosis.missingSignals.some((signal) => signal.includes("route")) ? "routing-instrumentation" : "",
    ].filter(Boolean);
    return {
      autoloopId: autoloop?.id || "",
      attemptId: latestAttempt?.id || "",
      dominantFailureStep: diagnosis.dominantFailureStep,
      targetFilesHint,
      rootCauseHints: diagnosis.suspectedRootCauses,
      requiredSignals: collection?.signalGaps || [],
      repairScope,
      applicabilityStatus: targetSupport.status,
      blockingReasons,
      recommendedIntegrationMode: run.target === "web" ? "browser-injected" : "wrapper-first",
      successCriteria: [
        "closure.decision.status === resolved",
        "integrity warnings are acceptable for the target surface",
        "no new high-risk regressions appear in diff",
        "driver contract compliance remains true for the final run",
      ],
    };
  }

  getAutoloop(sessionId: string) {
    const session = this.autoloops.getById(sessionId);
    if (!session) return null;
    return {
      session,
      attempts: this.autoloops.listAttempts(sessionId).map((attempt) => ({
        ...attempt,
        repairOutcome: this.autoloops.getRepairOutcome(attempt.id),
      })),
      decision: this.getAutoloopDecision(sessionId),
    };
  }

  getAutoloopDecision(sessionId: string): AutoloopStopDecision | null {
    const session = this.autoloops.getById(sessionId);
    if (!session) return null;
    const attempts = this.autoloops.listAttempts(sessionId);
    const latestAttempt = attempts.at(-1) || null;
    const currentRunId = latestAttempt?.currentRunId || session.runId;
    const targetSupport = this.getTargetSupport(session.targetSurface);
    const closure = this.listRunClosure(currentRunId);
    const integrity = this.listRunIntegrity(currentRunId);
    const diagnosis = this.listRunDiagnosis(currentRunId);
    const collection = this.listRunCollection(currentRunId);
    if (!closure || !diagnosis || !collection) return null;

    if (targetSupport.status === "unsupported") {
      return {
        status: "halted",
        reason: "unsupported_target",
        confidence: 0.99,
        evidence: [targetSupport.reasonCode],
        shouldContinue: false,
        nextAction: "stop",
      };
    }
    if (targetSupport.status === "inapplicable") {
      return {
        status: "halted",
        reason: "inapplicable_runtime",
        confidence: 0.99,
        evidence: [targetSupport.reasonCode],
        shouldContinue: false,
        nextAction: "stop",
      };
    }
    const driverCheck = this.getDriverContractCompliance(currentRunId);
    if (driverCheck && !driverCheck.compliant) {
      return {
        status: "halted",
        reason: "driver_contract_failed",
        confidence: 0.96,
        evidence: driverCheck.missingRequirements,
        shouldContinue: false,
        nextAction: "fix_driver_contract",
      };
    }
    if (session.targetSurface === "miniapp") {
      return {
        status: "halted",
        reason: "miniapp_verify_required",
        confidence: 0.98,
        evidence: [targetSupport.reasonCode],
        shouldContinue: false,
        nextAction: "run_miniapp_verify",
      };
    }

    if (closure.decision.status === "resolved") {
      return {
        status: "resolved",
        reason: "closure_resolved",
        confidence: closure.confidence,
        evidence: closure.evidence,
        shouldContinue: false,
        nextAction: "stop",
      };
    }
    if (collection.status === "incomplete" || integrity.integrityScore < 70) {
      return {
        status: "halted",
        reason: "insufficient_collection",
        confidence: 0.95,
        evidence: collection.signalGaps.length > 0 ? collection.signalGaps : integrity.warnings,
        shouldContinue: false,
        nextAction: "fix_integration",
      };
    }
    if (closure.hasRegression) {
      return {
        status: "halted",
        reason: "regression",
        confidence: 0.9,
        evidence: closure.evidence,
        shouldContinue: false,
        nextAction: "review_regression",
      };
    }
    if (attempts.length >= session.maxAttempts) {
      return {
        status: "halted",
        reason: "max_attempts",
        confidence: 0.88,
        evidence: [`attempts=${attempts.length}`, ...closure.evidence],
        shouldContinue: false,
        nextAction: "report_artifact",
      };
    }
    if (this.hasNoProgress(sessionId)) {
      return {
        status: "halted",
        reason: "no_progress",
        confidence: 0.85,
        evidence: [`attempts=${attempts.length}`, ...closure.evidence],
        shouldContinue: false,
        nextAction: "report_stalled_loop",
      };
    }
    if (!diagnosis.dominantFailureStep && diagnosis.topIncidents.length === 0) {
      return {
        status: "escalated",
        reason: "low_confidence_diagnosis",
        confidence: 0.55,
        evidence: diagnosis.missingSignals,
        shouldContinue: false,
        nextAction: "collect_more_signals",
      };
    }
    return {
      status: "escalated",
      reason: "continue_repair",
      confidence: 0.72,
      evidence: closure.evidence,
      shouldContinue: true,
      nextAction: "repair_and_retest",
    } as const;
  }

  async identifyProject(target?: string): Promise<ProjectProfile | null> {
    const identified = await this.inspector.identify(target);
    if (!identified.supportedTarget) return null;
    if (identified.supportedTarget === "web") {
      const report = await this.inspectWebProject();
      const profile = this.inspector.toProfile({
        target: "web",
        framework: report.framework,
        integrationMode: "browser-injected",
        knownEntrypoints: report.entrypoints.map((item) => item.path),
        knownSignalGaps: report.blockingIssues,
        projectRoot: identified.projectRoot,
      });
      await this.projectMemory.upsertProfile(profile);
      return profile;
    }
    const report = await this.inspectMiniappProject();
    const profile = this.inspector.toProfile({
      target: "miniapp",
      framework: "miniapp",
      integrationMode: report.wrapperCoverage > 0 ? "wrapper-first" : "manual-fallback",
      knownEntrypoints: [report.appEntry].filter(Boolean),
      knownSignalGaps: report.blockingIssues,
      projectRoot: identified.projectRoot,
    });
    await this.projectMemory.upsertProfile(profile);
    return profile;
  }

  getProjectProfile(projectId: string): ProjectProfile | null {
    return this.projectMemory.getProfile(projectId);
  }

  getProjectHistory(projectId: string): ProjectMemoryRecord[] {
    return this.projectMemory.listRecords(projectId);
  }

  getProjectMemory(projectId: string): ProjectKnowledgeSnapshot | null {
    return this.projectMemory.snapshot(projectId);
  }

  async inspectWebProject(): Promise<WebIntegrationReport> {
    return this.inspector.inspectWeb();
  }

  async inspectMiniappProject(): Promise<MiniappProjectIntegrationReport> {
    return this.inspector.inspectMiniapp();
  }

  getMiniappSignalReport(runId: string): MiniappSignalReport | null {
    const run = this.runs.getRun(runId);
    if (!run || run.target !== "miniapp") return null;
    const events = this.events.listByRun(runId);
    const routeTransitions = events.filter((event) => event.phase === "navigation").length;
    const lifecycleTransitions = events.filter((event) => event.phase === "lifecycle").length;
    const setDataEvents = events.filter((event) => event.message.includes("setData") || event.tags.includes("setData"));
    const requestEvents = events.filter((event) => event.phase === "network");
    const requestToUiContinuity =
      requestEvents.length === 0
        ? "missing"
        : requestEvents.some((event) =>
              events.some(
                (candidate) =>
                  candidate.sequence > event.sequence &&
                  candidate.sequence <= event.sequence + 5 &&
                  (candidate.phase === "lifecycle" || candidate.message.includes("setData"))
              )
            )
          ? "complete"
          : "partial";
    return {
      runId,
      setDataCoverage: setDataEvents.length > 0 ? 100 : 0,
      routeTransitions,
      lifecycleContinuity: lifecycleTransitions > 1 ? "complete" : lifecycleTransitions > 0 ? "partial" : "missing",
      requestToUiContinuity,
      warnings: [
        ...(setDataEvents.length === 0 ? ["missing_setData_signal"] : []),
        ...(requestToUiContinuity !== "complete" ? ["missing_request_to_ui_continuity"] : []),
      ],
    };
  }

  getRunFailureChain(runId: string): RunFailureChain | null {
    const diagnosis = this.listRunDiagnosis(runId);
    if (!diagnosis) return null;
    return {
      runId,
      dominantFailureStep: diagnosis.dominantFailureStep?.name || "",
      firstFailureSequence: diagnosis.firstFailureSequence,
      evidence: [
        ...diagnosis.suspectedRootCauses.map((item) => item.message),
        ...diagnosis.missingSignals.map((item) => `missing:${item}`),
      ].slice(0, 10),
      incidentFingerprints: diagnosis.topIncidents.map((item) => item.fingerprint).slice(0, 10),
      rootCauseHints: diagnosis.suspectedRootCauses,
    };
  }

  getRunRepairStrategy(runId: string): RunRepairStrategy | null {
    const brief = this.getRepairBrief(runId);
    if (!brief) return null;
    const summary =
      brief.repairScope === "integration_first"
        ? "Fix instrumentation and signal gaps before changing business logic."
        : brief.repairScope === "regression_containment"
          ? "Contain the new regression before broader refactors."
          : brief.repairScope === "evidence_insufficient"
            ? "Collect stronger evidence before structural changes."
            : "Focus the repair on the dominant runtime failure chain.";
    return {
      runId,
      strategy: brief.repairScope,
      summary,
      reasons: [...brief.blockingReasons, ...brief.rootCauseHints.map((item) => item.kind)],
      successCriteria: brief.successCriteria,
    };
  }

  getRunHandoff(runId: string): HandoffArtifact | null {
    const run = this.runs.getRun(runId);
    const closure = this.listRunClosure(runId);
    const integrity = this.listRunIntegrity(runId);
    if (!run || !closure) return null;
    const autoloop = this.autoloops.getByRunId(runId);
    const attempts = autoloop ? this.autoloops.listAttempts(autoloop.id).map((attempt) => ({ ...attempt, repairOutcome: this.autoloops.getRepairOutcome(attempt.id) })) : [];
    const project = this.resolveProjectProfileForRun(runId);
    const collection = this.listRunCollection(runId);
    const decision = autoloop ? this.getAutoloopDecision(autoloop.id) : null;
    return {
      project,
      run,
      closure,
      verdict: this.buildClosureVerdict(
        runId,
        this.getTargetSupport(run.target),
        this.getRunReadiness(runId),
        this.getDriverContractCompliance(runId),
        collection,
        closure
      ),
      integrity,
      dominantFailureChain: this.getRunFailureChain(runId),
      topIncidents: this.listRunIncidents(runId, 10),
      signalGaps: collection?.signalGaps || [],
      attemptHistory: attempts,
      whatWasTried: attempts.flatMap((attempt) =>
        attempt.repairOutcome
          ? [
              `${attempt.id}:${attempt.repairOutcome.changedFiles.join(",")}`,
              ...(attempt.repairOutcome.assumptionDelta || []),
            ]
          : []
      ),
      whyStopped: decision?.reason || closure.decision.reason,
      recommendedNextActions: [
        ...(collection?.recommendedCollectionFixes || []),
        ...(decision?.nextAction ? [decision.nextAction] : []),
        ...(this.getRunRepairStrategy(runId)?.successCriteria || []).slice(0, 3),
      ],
    };
  }

  async getRunArtifact(runId: string, filePath?: string): Promise<{ artifact: DiagnosisArtifact; filePath: string }> {
    const run = this.runs.getRun(runId);
    if (!run) throw new Error("run_not_found");
    const summary = this.listRunSummary(runId);
    const flow = this.listRunFlow(runId);
    const diagnosis = this.listRunDiagnosis(runId);
    const closure = this.listRunClosure(runId);
    const integrity = this.listRunIntegrity(runId);
    if (!diagnosis || !closure) throw new Error("artifact_unavailable");
    const baselineRunId = this.resolveBaselineRunId(runId);
    const diff = baselineRunId
      ? { baselineRunId, currentRunId: runId, changed: this.diffRuns(baselineRunId, runId).changed }
      : undefined;
    const targetSupport = this.getTargetSupport(run.target);
    const triggerDecision = this.getTriggerDecision({
      target: run.target,
      phase: run.status === "running" ? "manual" : "retest",
      runtimeImpact: true,
      reason: run.label,
    });
    const collection = this.listRunCollection(runId);
    const report = this.getRunReport(runId);
    const project = await this.ensureProjectProfileForRun(runId);
    const memoryRecord = await this.syncProjectMemoryForRun(runId);
    const artifact: DiagnosisArtifact = {
      run,
      summary,
      flow,
      timelineExcerpt: this.listRunTimeline(runId, { limit: Math.max(10, this.config.contextWindowSize) }),
      topIncidents: this.listRunIncidents(runId, 10),
      collection: collection || undefined,
      hotSpots: this.listRunHotspots(runId).slice(0, 10),
      diagnosis,
      closure,
      report: report || undefined,
      repairBrief: this.getRepairBrief(runId),
      readiness: this.getRunReadiness(runId) || undefined,
      driverCheck: this.getDriverContractCompliance(runId) || undefined,
      evidenceSource: "runtime_relay",
      integrationMode: run.target === "web" ? "browser-injected" : "wrapper-first",
      targetSupport,
      triggerDecision,
      project: project || undefined,
      projectMemoryRef:
        project && memoryRecord?.recordFile
          ? {
              projectId: project.projectId,
              recordFile: memoryRecord.recordFile,
            }
          : undefined,
      closureEligibility: {
        eligible: targetSupport.status === "supported" && collection?.status !== "incomplete",
        blockingReasons: [
          ...(targetSupport.status === "supported" ? [] : [targetSupport.reasonCode]),
          ...(collection?.signalGaps || []),
        ],
      },
      failureChain: this.getRunFailureChain(runId),
      repairStrategy: this.getRunRepairStrategy(runId),
      handoff: this.getRunHandoff(runId),
      autoloop: (() => {
        const session = this.autoloops.getByRunId(runId);
        return session ? this.getAutoloop(session.id) : null;
      })(),
      diff,
      integrity,
      checkpoints: this.orchestrations.listCheckpoints(runId),
      generatedAt: nowIso(),
    };
    const finalPath = filePath || `${runId}-${Date.now()}.json`;
    const written = await writeArtifact(this.config.artifactDir, path.basename(finalPath), artifact);
    return { artifact, filePath: written };
  }

  listIncidents(windowMinutes: number, limit: number): RelaySnapshot {
    const incidents = this.incidents.listTop({ windowStartIso: startWindowIso(windowMinutes), limit });
    const snapshot: RelaySnapshot = {
      checkpoint: this.createCheckpoint(),
      createdAt: nowIso(),
      total: incidents.length,
      incidents,
    };
    this.snapshots.set(snapshot.checkpoint, snapshot);
    this.snapshotOrder.push(snapshot.checkpoint);
    if (this.snapshotOrder.length > 50) {
      const removed = this.snapshotOrder.splice(0, this.snapshotOrder.length - 50);
      for (const checkpoint of removed) this.snapshots.delete(checkpoint);
    }
    return snapshot;
  }

  listContext(fingerprint: string, before: number, after: number): RelayLogEvent[] {
    const latest = this.events.latestByFingerprint(fingerprint);
    if (!latest) return [];
    return this.events.aroundEvent(latest.id, before, after);
  }

  diffRuns(baselineRunId: string, currentRunId: string): { baselineFound: boolean; currentFound: boolean; changed: RunDiffItem[] } {
    const baseline = this.runs.getRun(baselineRunId);
    const current = this.runs.getRun(currentRunId);
    if (!baseline || !current) {
      return { baselineFound: Boolean(baseline), currentFound: Boolean(current), changed: [] };
    }
    const baselineFingerprints = this.incidents.listFingerprintsForRun(baselineRunId);
    const currentFingerprints = this.incidents.listFingerprintsForRun(currentRunId);
    const fingerprints = new Set([...baselineFingerprints, ...currentFingerprints]);
    const changed = Array.from(fingerprints)
      .map((fingerprint) => {
        const baselineCount = this.incidents.countForRun(fingerprint, baselineRunId);
        const currentCount = this.incidents.countForRun(fingerprint, currentRunId);
        return {
          fingerprint,
          baselineCount,
          currentCount,
          delta: currentCount - baselineCount,
          status: this.classifyDiff(fingerprint, baselineRunId, currentRunId, baselineCount, currentCount),
        } satisfies RunDiffItem;
      })
      .filter((item) => item.delta !== 0)
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
    return { baselineFound: true, currentFound: true, changed };
  }

  diffSnapshots(baseline: string, current: string): { baselineFound: boolean; currentFound: boolean; changed: Array<{ fingerprint: string; delta: number; baselineCount: number; currentCount: number }> } {
    const a = this.snapshots.get(baseline);
    const b = this.snapshots.get(current);
    if (!a || !b) return { baselineFound: !!a, currentFound: !!b, changed: [] };
    const baselineMap = new Map(a.incidents.map((item) => [item.fingerprint, item.count]));
    const currentMap = new Map(b.incidents.map((item) => [item.fingerprint, item.count]));
    const keys = new Set([...baselineMap.keys(), ...currentMap.keys()]);
    const changed = Array.from(keys)
      .map((fingerprint) => {
        const baselineCount = Number(baselineMap.get(fingerprint) || 0);
        const currentCount = Number(currentMap.get(fingerprint) || 0);
        return { fingerprint, delta: currentCount - baselineCount, baselineCount, currentCount };
      })
      .filter((item) => item.delta !== 0)
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
    return { baselineFound: true, currentFound: true, changed };
  }

  health(): { buffered: number; pending: number; snapshots: number; runs: number; activeRuns: number; autoloops: number } {
    return {
      buffered: this.events.size(),
      pending: this.queue.size(),
      snapshots: this.snapshots.size,
      runs: this.runs.totalRuns(),
      activeRuns: this.runs.activeRunsCount(),
      autoloops: this.autoloops.totalSessions(),
    };
  }

  getRun(runId: string): TestRun | null {
    return this.runs.getRun(runId);
  }

  getStep(runId: string, stepId: string) {
    return this.runs.getStep(runId, stepId);
  }

  getOrchestration(runId: string) {
    return this.orchestrations.getSession(runId);
  }

  listCheckpoints(runId: string) {
    return this.orchestrations.listCheckpoints(runId);
  }

  buildMiniappIntegrationReport(args: { wrapperUsed: boolean; patchCapabilities: string[]; routeSignals: number; lifecycleSignals: number; networkSignals: number; warnings: string[] }): MiniappIntegrationReport {
    const wrapperCoverage = args.wrapperUsed ? 100 : 0;
    const patchCoverage = Math.min(100, args.patchCapabilities.length * 20);
    const routeCoverage = args.routeSignals > 0 ? 100 : 0;
    const lifecycleCoverage = args.lifecycleSignals > 0 ? 100 : 0;
    const networkCoverage = args.networkSignals > 0 ? 100 : 0;
    const blockingReasons = [
      ...(args.wrapperUsed ? [] : ["wrapper_not_used"]),
      ...(args.lifecycleSignals > 0 ? [] : ["missing_lifecycle_signals"]),
      ...(args.routeSignals > 0 || args.networkSignals > 0 ? [] : ["missing_route_or_network_signals"]),
    ];
    return {
      wrapperCoverage,
      patchCoverage,
      routeCoverage,
      lifecycleCoverage,
      networkCoverage,
      integrationMode: args.wrapperUsed ? (args.patchCapabilities.length > 0 ? "patch-enhanced" : "wrapper-first") : "manual-fallback",
      consoleReady: true,
      lifecycleReady: args.lifecycleSignals > 0,
      routeReady: args.routeSignals > 0,
      networkReady: args.networkSignals > 0,
      autoloopEligible: false,
      blockingReasons,
      warnings: args.warnings,
    };
  }

  private drainQueue(): void {
    const batch = this.queue.dequeueBatch(500);
    for (const event of batch) {
      this.events.push(event);
      if (event.level === "warn" || event.level === "error") this.incidents.upsert(event);
    }
  }

  private toTimelineItem(event: RelayLogEvent, runId: string): TimelineItem {
    if (event.level === "error" || event.level === "warn") {
      const incident = this.incidents.listTop({ runId, limit: 200 }).find((item) => item.fingerprint === event.fingerprint);
      if (incident) {
        return { type: "incident_marker", sequence: event.sequence, timestamp: event.timestamp, event, incident };
      }
    }
    if (event.phase === "network") return { type: "network_event", sequence: event.sequence, timestamp: event.timestamp, event };
    if (event.phase === "lifecycle" || event.phase === "navigation") return { type: "lifecycle_event", sequence: event.sequence, timestamp: event.timestamp, event };
    if (event.phase === "resource") return { type: "resource_event", sequence: event.sequence, timestamp: event.timestamp, event };
    if (event.phase === "render") return { type: "render_event", sequence: event.sequence, timestamp: event.timestamp, event };
    if (event.phase === "guard") return { type: "runtime_guard_event", sequence: event.sequence, timestamp: event.timestamp, event };
    return { type: "log_event", sequence: event.sequence, timestamp: event.timestamp, event };
  }

  private findDominantFailureStep(runId: string, fingerprint: string) {
    const steps = this.runs.listSteps(runId);
    if (!steps.length) return null;
    if (!fingerprint) {
      return steps.find((step) => this.events.listByStep(runId, step.id).some((event) => event.level === "error")) || null;
    }
    for (const step of steps) {
      const events = this.events.listByStep(runId, step.id);
      if (events.some((event) => event.fingerprint === fingerprint)) return step;
    }
    return steps.find((step) => this.events.listByStep(runId, step.id).some((event) => event.level === "error")) || null;
  }

  private findRootCauses(runId: string, step: RunDiagnosis["dominantFailureStep"], firstFailureSequence: number, incidents: RelayIncident[]): RootCauseHint[] {
    const events = this.events.listByRun(runId);
    const hints: RootCauseHint[] = [];
    const firstNetworkFailure = events.find((event) => event.phase === "network" && (event.level === "error" || event.level === "warn"));
    if (firstNetworkFailure && firstFailureSequence && firstNetworkFailure.sequence <= firstFailureSequence) {
      hints.push({
        kind: "network_precedes_ui",
        message: `Network failure occurred before the visible failure in step ${safeStepName(step)}.`,
        evidenceSequences: [firstNetworkFailure.sequence, firstFailureSequence].filter(Boolean),
        relatedFingerprints: [firstNetworkFailure.fingerprint].filter(Boolean),
      });
    }
    const firstLifecycleFailure = events.find((event) => event.phase === "lifecycle" && event.level === "error");
    if (firstLifecycleFailure) {
      hints.push({
        kind: "lifecycle_interrupted",
        message: "A lifecycle error interrupted the expected execution chain.",
        evidenceSequences: [firstLifecycleFailure.sequence],
        relatedFingerprints: [firstLifecycleFailure.fingerprint],
      });
    }
    const firstNavigationFailure = events.find((event) => event.phase === "navigation" && firstFailureSequence && event.sequence < firstFailureSequence);
    if (firstNavigationFailure && firstFailureSequence) {
      hints.push({
        kind: "navigation_breakage",
        message: "Route transition happened immediately before the failure.",
        evidenceSequences: [firstNavigationFailure.sequence, firstFailureSequence],
        relatedFingerprints: incidents.slice(0, 1).map((incident) => incident.fingerprint),
      });
    }
    if (step) {
      const stepEvents = this.events.listByStep(runId, step.id);
      const stepFingerprints = new Set(stepEvents.filter((event) => event.level === "error" || event.level === "warn").map((event) => event.fingerprint));
      if (stepFingerprints.size > 0) {
        hints.push({
          kind: "step_concentration",
          message: `Failures are concentrated in step ${step.name}.`,
          evidenceSequences: stepEvents.filter((event) => stepFingerprints.has(event.fingerprint)).slice(0, 3).map((event) => event.sequence),
          relatedFingerprints: Array.from(stepFingerprints).slice(0, 3),
        });
      }
    }
    const integrity = this.listRunIntegrity(runId);
    if (integrity.warnings.length > 0) {
      hints.push({
        kind: "missing_signal",
        message: `Signal coverage is incomplete: ${integrity.warnings.join(", ")}.`,
        evidenceSequences: [],
        relatedFingerprints: [],
      });
    }
    return hints.slice(0, 5);
  }

  private classifyClosure(run: TestRun, summary: RunSummary, diff: RunDiffItem[], isResolved: boolean, hasRegression: boolean): RunClosure["decision"] {
    if (isResolved) {
      return { status: "resolved", confidence: 0.92, reason: "The run passed without remaining incidents or errors compared to baseline." };
    }
    if (hasRegression) {
      return { status: "regressed", confidence: 0.88, reason: "The current run introduced or intensified failures relative to baseline." };
    }
    if (run.status === "failed" || summary.errorCount > 0 || summary.incidentCount > 0 || diff.some((item) => item.status === "new")) {
      return { status: "unresolved", confidence: 0.84, reason: "The current run still contains unresolved incidents or errors." };
    }
    return { status: "inconclusive", confidence: 0.55, reason: "The run ended cleanly, but evidence is insufficient to claim closure." };
  }

  private buildClosureVerdict(
    runId: string,
    support: TargetCapabilityReport,
    runtimeReadiness: ReturnType<RelayEngine["getRunReadiness"]>,
    driverCheck: DriverContractComplianceReport | null,
    collection: BugCollectionReport | null,
    closure: RunClosure | null
  ): ClosureVerdict {
    if (support.status === "unsupported" || support.status === "inapplicable") {
      return {
        status: "unsupported",
        reason: support.reasonCode,
        confidence: 0.99,
        nextAction: support.recommendedAction,
      };
    }
    if (support.target === "miniapp" && (!runtimeReadiness || runtimeReadiness.evidenceLevel !== "runtime_verified" || collection?.status !== "complete")) {
      return {
        status: "integration_required",
        reason: "miniapp_verify_required",
        confidence: 0.92,
        nextAction: "Run miniapp verify and collect runtime signals before claiming closure.",
      };
    }
    if (!runtimeReadiness || runtimeReadiness.evidenceLevel !== "runtime_verified") {
      return {
        status: "integration_required",
        reason: "runtime_unverified",
        confidence: 0.9,
        nextAction: "Run a real instrumented flow and query run-scoped readiness.",
      };
    }
    if (driverCheck && !driverCheck.compliant) {
      return {
        status: "integration_required",
        reason: "driver_contract_failed",
        confidence: 0.95,
        nextAction: "Fix run/step binding and required signal capture before closure claims.",
      };
    }
    if (!collection || collection.status !== "complete") {
      return {
        status: "integration_required",
        reason: "insufficient_collection",
        confidence: 0.94,
        nextAction: "Fix missing signals before closure claims.",
      };
    }
    if (!closure) {
      return {
        status: "inconclusive",
        reason: "missing_closure",
        confidence: 0.4,
        nextAction: "Query closure after the run finishes.",
      };
    }
    if (closure.decision.status === "resolved") {
      return {
        status: "resolved",
        reason: "closure_resolved",
        confidence: closure.confidence,
        nextAction: "Stop and report closure evidence.",
      };
    }
    if (closure.decision.status === "running") {
      return {
        status: "inconclusive",
        reason: "run_in_progress",
        confidence: closure.confidence,
        nextAction: "Wait for run completion, then re-check closure.",
      };
    }
    if (closure.decision.status === "regressed" || closure.hasRegression) {
      return {
        status: "unresolved",
        reason: "regression",
        confidence: closure.confidence,
        nextAction: "Review regressions and produce handoff if not immediately fixable.",
      };
    }
    return {
      status: closure.decision.status === "unresolved" ? "unresolved" : "inconclusive",
      reason: closure.decision.reason,
      confidence: closure.confidence,
      nextAction: closure.decision.status === "unresolved" ? "Use repair brief and handoff to continue from evidence." : "Do not claim done; gather stronger runtime evidence.",
    };
  }

  private matchesLevel(actual: RelayLogEvent["level"], filter: RelayLogEvent["level"]): boolean {
    const ranking = { debug: 1, info: 2, warn: 3, error: 4 };
    return ranking[actual] >= ranking[filter];
  }

  private classifyDiff(fingerprint: string, baselineRunId: string, currentRunId: string, baselineCount: number, currentCount: number): RunDiffItem["status"] {
    if (baselineCount === 0 && currentCount > 0) {
      return this.incidents.hasSeenOutsideRuns(fingerprint, [baselineRunId, currentRunId]) ? "regressed" : "new";
    }
    if (baselineCount > 0 && currentCount === 0) return "resolved";
    if (currentCount > baselineCount) return "unchanged-increased";
    return "unchanged-reduced";
  }

  private resolveBaselineRunId(runId: string): string {
    return this.orchestrations.getSession(runId)?.baselineRunId || this.runs.previousCompletedRunId(runId);
  }

  private hasNoProgress(sessionId: string): boolean {
    const attempts = this.autoloops.listAttempts(sessionId);
    if (attempts.length < 2) return false;
    const recent = attempts.slice(-2);
    const summaries = recent.map((attempt) => this.listRunSummary(attempt.currentRunId));
    return summaries[1].errorCount >= summaries[0].errorCount && summaries[1].incidentCount >= summaries[0].incidentCount;
  }

  private async ensureProjectProfileForRun(runId: string): Promise<ProjectProfile | null> {
    const run = this.runs.getRun(runId);
    if (!run || (run.target !== "web" && run.target !== "miniapp")) return null;
    const existingProjectId = typeof run.metadata.projectId === "string" ? String(run.metadata.projectId) : "";
    if (existingProjectId) {
      const existing = this.projectMemory.getProfile(existingProjectId);
      if (existing) return existing;
    }
    const profile = await this.identifyProject(run.target);
    if (profile) {
      run.metadata = { ...run.metadata, projectId: profile.projectId };
    }
    return profile;
  }

  private resolveProjectProfileForRun(runId: string): ProjectProfile | null {
    const run = this.runs.getRun(runId);
    const projectId = run && typeof run.metadata.projectId === "string" ? String(run.metadata.projectId) : "";
    return projectId ? this.projectMemory.getProfile(projectId) : null;
  }

  private async syncProjectMemoryForRun(runId: string): Promise<ProjectMemoryRecord | null> {
    const run = this.runs.getRun(runId);
    if (!run || run.status === "running" || (run.target !== "web" && run.target !== "miniapp")) return null;
    const profile = await this.ensureProjectProfileForRun(runId);
    if (!profile) return null;
    const autoloop = this.autoloops.getByRunId(runId);
    const diff = this.resolveBaselineRunId(runId) ? this.diffRuns(this.resolveBaselineRunId(runId), runId).changed : [];
    const closure = this.listRunClosure(runId);
    const repairOutcome = autoloop
      ? this.autoloops
          .listAttempts(autoloop.id)
          .map((attempt) => this.autoloops.getRepairOutcome(attempt.id))
          .filter((item): item is RepairOutcome => Boolean(item))
      : [];
    return this.projectMemory.appendRecord({
      projectId: profile.projectId,
      runId,
      autoloopId: autoloop?.id || "",
      dominantFailureChain: this.getRunFailureChain(runId)?.evidence || [],
      resolvedFingerprints: diff.filter((item) => item.status === "resolved").map((item) => item.fingerprint),
      regressedFingerprints: diff.filter((item) => item.status === "regressed" || item.status === "new").map((item) => item.fingerprint),
      integrationFixes: [
        ...(this.listRunCollection(runId)?.recommendedCollectionFixes || []),
        ...(closure?.decision.status === "inconclusive" ? ["closure_inconclusive"] : []),
      ],
      repairOutcomes: repairOutcome,
      recordedAt: nowIso(),
    });
  }

  private getCollectionSignalGaps(runId: string, integrity: IntegrityReport): string[] {
    const run = this.runs.getRun(runId);
    if (!run) {
      return ["missing_run"];
    }
    const gaps: string[] = [];
    if (!integrity.hasStepBoundaries) {
      gaps.push("missing_step_boundaries");
    }
    if (!integrity.hasErrorsOrAssertions) {
      gaps.push("missing_errors_or_assertions");
    }
    if (run.target === "miniapp") {
      if (!integrity.hasLifecycleSignals) {
        gaps.push("missing_lifecycle_signals");
      }
      if (!integrity.hasRouteSignals && !integrity.hasNetworkSignals) {
        gaps.push("missing_route_or_network_signals");
      }
      return gaps;
    }
    if (!integrity.hasRouteSignals && !integrity.hasNetworkSignals) {
      gaps.push("missing_route_or_network_signals");
    }
    if (!integrity.hasRenderSignals) {
      gaps.push("missing_render_signals");
    }
    return gaps;
  }

  private isValidInput(input: RelayLogInput): input is RelayLogInput {
    return Boolean(
      input &&
        (input.source === "miniapp" || input.source === "admin-web" || input.source === "backend") &&
        (input.level === "debug" || input.level === "info" || input.level === "warn" || input.level === "error") &&
        typeof input.message === "string"
    );
  }

  private createCheckpoint(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
