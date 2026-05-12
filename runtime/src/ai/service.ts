import type {
    AutoloopAttemptCompleteInput,
    AutoloopAttemptStartInput,
    AutoloopStartInput,
    CheckpointInput,
    ClosureEvidenceReport,
    LogLevel,
  OrchestrationStartInput,
  RepairOutcome,
  RunStatus,
    TestTarget,
    TaskEnforcementReport,
    TriggerPhase,
  } from "../types.js";
import type { RelayEngine } from "../core/relay-engine.js";

export class AiQueryService {
  constructor(private readonly engine: RelayEngine) {}

  incidents(windowMinutes: number, limit: number) {
    return this.engine.listIncidents(windowMinutes, limit);
  }

  context(fingerprint: string, before: number, after: number) {
    return {
      fingerprint,
      events: this.engine.listContext(fingerprint, before, after),
    };
  }

  diff(baseline: string, current: string) {
    return this.engine.diffSnapshots(baseline, current);
  }

  startOrchestration(input: OrchestrationStartInput) {
    return this.engine.startOrchestration(input);
  }

  startAutoloop(input: AutoloopStartInput) {
    return this.engine.startAutoloop(input);
  }

  startAutoloopAttempt(sessionId: string, input: AutoloopAttemptStartInput) {
    return this.engine.startAutoloopAttempt(sessionId, input);
  }

  completeAutoloopAttempt(sessionId: string, attemptId: string, input: AutoloopAttemptCompleteInput) {
    return this.engine.completeAutoloopAttempt(sessionId, attemptId, input);
  }

  recordRepairOutcome(sessionId: string, attemptId: string, input: RepairOutcome) {
    return this.engine.recordRepairOutcome(sessionId, attemptId, input);
  }

  checkpoint(runId: string, input: CheckpointInput) {
    return this.engine.addCheckpoint(runId, input);
  }

  runs(limit: number, status?: RunStatus, target?: TestTarget) {
    return this.engine.listRuns({ limit, status, target });
  }

  runTimeline(runId: string, cursor: number, limit: number, level?: LogLevel) {
    return this.engine.listRunTimeline(runId, { cursor, limit, level });
  }

  runSummary(runId: string) {
    return this.engine.listRunSummary(runId);
  }

  runIncidents(runId: string, limit: number) {
    return this.engine.listRunIncidents(runId, limit);
  }

  runContext(runId: string, fingerprint: string, before: number, after: number) {
    return this.engine.listRunContext(runId, fingerprint, before, after);
  }

  runFlow(runId: string) {
    return this.engine.listRunFlow(runId);
  }

  runDiff(baselineRunId: string, currentRunId: string) {
    return this.engine.diffRuns(baselineRunId, currentRunId);
  }

  runDiagnosis(runId: string) {
    return this.engine.listRunDiagnosis(runId);
  }

  runClosure(runId: string) {
    return this.engine.listRunClosure(runId);
  }

  runIntegrity(runId: string) {
    return this.engine.listRunIntegrity(runId);
  }

  runCollection(runId: string) {
    return this.engine.listRunCollection(runId);
  }

  runHotspots(runId: string) {
    return this.engine.listRunHotspots(runId);
  }

  runRepairBrief(runId: string) {
    return this.engine.getRepairBrief(runId);
  }

  autoloop(sessionId: string) {
    return this.engine.getAutoloop(sessionId);
  }

  autoloopDecision(sessionId: string) {
    return this.engine.getAutoloopDecision(sessionId);
  }

  targetSupport(target: string) {
    return this.engine.getTargetSupport(target);
  }

  webIntegrationGuide() {
    return this.engine.getWebIntegrationGuide();
  }

  miniappIntegrationGuide() {
    return this.engine.getMiniappIntegrationGuide();
  }

  driverContract(target: string, driver: string) {
    return this.engine.getDriverContract(target, driver);
  }

  detectTarget(target?: string, projectRoot?: string) {
    return this.engine.detectTarget(target, projectRoot);
  }

  projectCompatibility(target?: string, projectRoot?: string) {
    return this.engine.getProjectCompatibility(target, projectRoot);
  }

  projectResolution(target?: string, projectRoot?: string) {
    return this.engine.getProjectResolution(target, projectRoot);
  }

  runDriverCheck(runId: string, driver?: string) {
    return this.engine.getDriverContractCompliance(runId, driver);
  }

  identifyProject(target?: string, projectRoot?: string) {
    return this.engine.identifyProject(target, projectRoot);
  }

  inspectWebProject(projectRoot?: string) {
    return this.engine.inspectWebProject(projectRoot);
  }

  inspectMiniappProject(projectRoot?: string) {
    return this.engine.inspectMiniappProject(projectRoot);
  }

  projectProfile(projectId: string) {
    return this.engine.getProjectProfile(projectId);
  }

  projectHistory(projectId: string) {
    return this.engine.getProjectHistory(projectId);
  }

  projectMemory(projectId: string) {
    return this.engine.getProjectMemory(projectId);
  }

  triggerDecision(input: { target: string; reason?: string; phase?: TriggerPhase; runtimeImpact?: boolean }) {
    return this.engine.getTriggerDecision(input);
  }

  runReadiness(runId: string) {
    return this.engine.getRunReadiness(runId);
  }

  runActions(runId: string) {
    return this.engine.getRunActions(runId);
  }

  runStateSnapshots(runId: string) {
    return this.engine.getRunStateSnapshots(runId);
  }

  runRequestAttribution(runId: string) {
    return this.engine.getRunRequestAttribution(runId);
  }

  runFailureChain(runId: string) {
    return this.engine.getRunFailureChain(runId);
  }

  runRootCauseMap(runId: string) {
    return this.engine.getRunRootCauseMap(runId);
  }

  runRepairStrategy(runId: string) {
    return this.engine.getRunRepairStrategy(runId);
  }

  runHandoff(runId: string) {
    return this.engine.getRunHandoff(runId);
  }

  runExecutableHandoff(runId: string) {
    return this.engine.getExecutableHandoff(runId);
  }

  runReleaseDecision(runId: string) {
    return this.engine.getRunReleaseDecision(runId);
  }

  runVerificationReport(runId: string) {
    return this.engine.getRunVerificationReport(runId);
  }

  runMiniappSignals(runId: string) {
    return this.engine.getMiniappSignalReport(runId);
  }

  runMiniappObservation(runId: string) {
    return this.engine.getMiniappSignalReport(runId);
  }

  runArtifact(runId: string, filePath?: string) {
    return this.engine.getRunArtifact(runId, filePath);
  }

  scenarioTemplates(target?: TestTarget) {
    return this.engine.listScenarioTemplates(target === "web" || target === "miniapp" ? target : undefined);
  }

  scenarioInspect(templateName: string, target?: TestTarget) {
    return this.engine.inspectScenarioTemplate(templateName, target === "web" || target === "miniapp" ? target : undefined);
  }

  scenarioValidate(runId: string, spec: any) {
    return this.engine.validateScenario(runId, spec);
  }

  runScenario(runId: string) {
    return this.engine.getScenarioReport(runId);
  }

  projectScenarios(target?: TestTarget) {
    return this.engine.listProjectScenarioCatalog(target === "web" || target === "miniapp" ? target : undefined);
  }

  projectBaselines(target?: TestTarget) {
    return this.engine.listProjectBaselines(target === "web" || target === "miniapp" ? target : undefined);
  }

  runStateReport(runId: string) {
    return this.engine.getScenarioReport(runId)?.stateReport || null;
  }

  runBaseline(runId: string) {
    return this.engine.getBaseline(runId);
  }

  runScenarioDiff(baselineRunId: string, currentRunId: string) {
    return this.engine.diffScenarioBaselines(baselineRunId, currentRunId);
  }

  runStateDiff(baselineRunId: string, currentRunId: string) {
    const diff = this.engine.diffScenarioBaselines(baselineRunId, currentRunId);
    return {
      baselineFound: diff.baselineFound,
      currentFound: diff.currentFound,
      changed: diff.changed.filter((item) => item.kind === "state" || item.kind === "assertion"),
    };
  }

  runRegressionDiff(baselineRunId: string, currentRunId: string, scenarioId?: string) {
    return this.engine.getRegressionDiff(baselineRunId, currentRunId, scenarioId);
  }

  runSummaryView(runId: string) {
    return this.engine.getShortHumanSummary(runId);
  }

  runFailureReport(runId: string) {
    return this.engine.getFailureOnePager(runId);
  }

  runPrComment(runId: string) {
    return this.engine.getPrCommentSummary(runId);
  }

  runReport(runId: string): ClosureEvidenceReport | null {
    return this.engine.getRunReport(runId);
  }

  taskEnforcement(input: {
    target: string;
    phase?: TriggerPhase;
    runtimeImpact?: boolean;
    runId?: string;
    closureClaim?: boolean;
  }): TaskEnforcementReport {
    return this.engine.getTaskEnforcement(input);
  }

  ciResult(mode: "readiness" | "scenario-smoke" | "closure" | "report" | "regression", runId?: string) {
    return this.engine.getCiVerificationResult(mode, runId);
  }
}
