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

  runDriverCheck(runId: string, driver?: string) {
    return this.engine.getDriverContractCompliance(runId, driver);
  }

  identifyProject(target?: string) {
    return this.engine.identifyProject(target);
  }

  inspectWebProject() {
    return this.engine.inspectWebProject();
  }

  inspectMiniappProject() {
    return this.engine.inspectMiniappProject();
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

  runFailureChain(runId: string) {
    return this.engine.getRunFailureChain(runId);
  }

  runRepairStrategy(runId: string) {
    return this.engine.getRunRepairStrategy(runId);
  }

  runHandoff(runId: string) {
    return this.engine.getRunHandoff(runId);
  }

  runMiniappSignals(runId: string) {
    return this.engine.getMiniappSignalReport(runId);
  }

  runArtifact(runId: string, filePath?: string) {
    return this.engine.getRunArtifact(runId, filePath);
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
}
