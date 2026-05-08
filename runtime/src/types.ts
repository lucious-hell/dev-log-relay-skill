export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "miniapp" | "admin-web" | "backend";
export type TestTarget = "web" | "miniapp" | "mixed";
export type RunStatus = "running" | "passed" | "failed" | "aborted";
export type StepStatus = "running" | "passed" | "failed" | "aborted";
export type StepKind = "setup" | "navigate" | "action" | "assert" | "network" | "custom";
export type EventPhase = "log" | "navigation" | "network" | "lifecycle" | "resource" | "render" | "guard" | "system";
export type TimelineItemType =
  | "step_boundary"
  | "log_event"
  | "incident_marker"
  | "network_event"
  | "lifecycle_event"
  | "resource_event"
  | "render_event"
  | "runtime_guard_event";
export type DiffStatus = "new" | "resolved" | "regressed" | "unchanged-reduced" | "unchanged-increased";
export type ClosureStatus = "running" | "resolved" | "regressed" | "unresolved" | "inconclusive";
export type RootCauseKind = "network_precedes_ui" | "lifecycle_interrupted" | "navigation_breakage" | "step_concentration" | "missing_signal";
export type AutoloopStatus = "collecting" | "diagnosing" | "repairing" | "retesting" | "resolved" | "halted";
export type AutoloopDecisionStatus = "resolved" | "halted" | "escalated";
export type BugCollectionStatus = "complete" | "incomplete";
export type RepairRiskLevel = "low" | "medium" | "high";
export type SupportedTarget = "web" | "miniapp";
export type TargetSupportStatus = "supported" | "partial" | "unsupported" | "inapplicable";
export type TriggerPhase = "code_change" | "self_test" | "retest" | "regression_check" | "incident_review" | "manual";
export type IntegrationMaturity = "none" | "basic" | "preferred" | "strong";
export type EvidenceSource = "runtime_relay" | "ui_fallback" | "project_inspection";
export type WebFramework = "react-vite" | "vue-vite" | "nextjs" | "taro-h5" | "uniapp-h5" | "generic-web" | "unknown";
export type ExternalDriverType = "playwright" | "computer-use" | "ide-agent" | "generic-browser-agent";
export type ClosureVerdictStatus = "resolved" | "unresolved" | "inconclusive" | "unsupported" | "integration_required";

export interface RelayErrorInfo {
  code: string;
  message: string;
}

export interface RelayNetworkMeta {
  url?: string;
  method?: string;
  statusCode?: number;
  ok?: boolean;
  durationMs?: number;
  stage?: "start" | "success" | "fail";
}

export interface ProjectEntrypoint {
  path: string;
  role: "bootstrap" | "route" | "network" | "error-boundary" | "app" | "page" | "component";
}

export interface RelayLogInput {
  timestamp?: string;
  source: LogSource;
  level: LogLevel;
  message: string;
  route?: string;
  sessionId?: string;
  traceId?: string;
  requestId?: string;
  stack?: string;
  context?: Record<string, unknown>;
  tags?: string[];
  runId?: string;
  stepId?: string;
  phase?: EventPhase;
  errorKind?: string;
  component?: string;
  network?: RelayNetworkMeta;
}

export interface RelayLogEvent {
  id: string;
  sequence: number;
  timestamp: string;
  receivedAt: string;
  source: LogSource;
  level: LogLevel;
  message: string;
  route: string;
  sessionId: string;
  traceId: string;
  requestId: string;
  stack: string;
  context: Record<string, unknown>;
  tags: string[];
  priority: number;
  fingerprint: string;
  runId: string;
  stepId: string;
  phase: EventPhase;
  errorKind: string;
  component: string;
  network?: RelayNetworkMeta;
  lateEvent: boolean;
}

export interface TestRun {
  id: string;
  label: string;
  target: TestTarget;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  metadata: Record<string, unknown>;
}

export interface TestStep {
  id: string;
  runId: string;
  name: string;
  kind: StepKind;
  status: StepStatus;
  startedAt: string;
  endedAt: string;
  startedSequence: number;
  endedSequence: number;
  route: string;
  metadata: Record<string, unknown>;
}

export interface RelayIncident {
  fingerprint: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  level: LogLevel;
  sourceBreakdown: Record<LogSource, number>;
  routeBreakdown: Record<string, number>;
  sampleMessage: string;
  sampleStack: string;
  latestRunId: string;
  regressed: boolean;
  resolvedInCurrentRun: boolean;
}

export interface RelaySnapshot {
  checkpoint: string;
  createdAt: string;
  total: number;
  incidents: RelayIncident[];
}

export interface RunCheckpoint {
  id: string;
  runId: string;
  stepId: string;
  name: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface OrchestrationSession {
  runId: string;
  scenario: string;
  baselineRunId: string;
  recommendedSteps: Array<{
    name: string;
    kind: StepKind;
  }>;
  artifactPathHint: string;
  createdAt: string;
}

export interface RunSummary {
  runId: string;
  totalEvents: number;
  errorCount: number;
  warnCount: number;
  incidentCount: number;
  newIncidents: number;
  regressedIncidents: number;
  resolvedIncidents: number;
  status: RunStatus;
  topErrors: RelayIncident[];
}

export interface TimelineBoundaryItem {
  type: "step_boundary";
  sequence: number;
  timestamp: string;
  runId: string;
  stepId: string;
  action: "step_started" | "step_ended";
  step: TestStep;
}

export interface TimelineLogItem {
  type: "log_event";
  sequence: number;
  timestamp: string;
  event: RelayLogEvent;
}

export interface TimelineIncidentItem {
  type: "incident_marker";
  sequence: number;
  timestamp: string;
  event: RelayLogEvent;
  incident: RelayIncident;
}

export interface TimelineNetworkItem {
  type: "network_event";
  sequence: number;
  timestamp: string;
  event: RelayLogEvent;
}

export interface TimelineLifecycleItem {
  type: "lifecycle_event";
  sequence: number;
  timestamp: string;
  event: RelayLogEvent;
}

export interface TimelineResourceItem {
  type: "resource_event";
  sequence: number;
  timestamp: string;
  event: RelayLogEvent;
}

export interface TimelineRenderItem {
  type: "render_event";
  sequence: number;
  timestamp: string;
  event: RelayLogEvent;
}

export interface TimelineRuntimeGuardItem {
  type: "runtime_guard_event";
  sequence: number;
  timestamp: string;
  event: RelayLogEvent;
}

export type TimelineItem =
  | TimelineBoundaryItem
  | TimelineLogItem
  | TimelineIncidentItem
  | TimelineNetworkItem
  | TimelineLifecycleItem
  | TimelineResourceItem
  | TimelineRenderItem
  | TimelineRuntimeGuardItem;

export interface RunFlowStep {
  step: TestStep;
  counts: {
    totalEvents: number;
    errors: number;
    warns: number;
  };
  topIncidents: RelayIncident[];
}

export interface RunFlow {
  run: TestRun;
  steps: RunFlowStep[];
}

export interface RunDiffItem {
  fingerprint: string;
  baselineCount: number;
  currentCount: number;
  delta: number;
  status: DiffStatus;
}

export interface RootCauseHint {
  kind: RootCauseKind;
  message: string;
  evidenceSequences: number[];
  relatedFingerprints: string[];
}

export interface RunDiagnosis {
  runId: string;
  runStatus: RunStatus;
  dominantFailureStep: TestStep | null;
  firstFailureSequence: number;
  topIncidents: RelayIncident[];
  suspectedRootCauses: RootCauseHint[];
  missingSignals: string[];
  recommendedNextQueries: string[];
}

export interface ClosureDecision {
  status: ClosureStatus;
  confidence: number;
  reason: string;
}

export interface RunClosure {
  runId: string;
  baselineRunId: string;
  isResolved: boolean;
  hasRegression: boolean;
  newIncidentCount: number;
  resolvedIncidentCount: number;
  regressedIncidentCount: number;
  confidence: number;
  evidence: string[];
  decision: ClosureDecision;
}

export interface IntegrityReport {
  runId: string;
  hasStepBoundaries: boolean;
  hasNetworkSignals: boolean;
  hasRouteSignals: boolean;
  hasLifecycleSignals: boolean;
  hasRenderSignals?: boolean;
  hasResourceSignals?: boolean;
  hasErrorsOrAssertions: boolean;
  integrityScore: number;
  warnings: string[];
  capturedCapabilities: string[];
}

export interface TimelineHotspot {
  sequence: number;
  type: TimelineItem["type"];
  message: string;
  fingerprint: string;
}

export interface DiagnosisArtifact {
  run: TestRun;
  summary: RunSummary;
  flow: RunFlow | null;
  timelineExcerpt: TimelineItem[];
  topIncidents: RelayIncident[];
  collection?: BugCollectionReport;
  hotSpots?: TimelineHotspot[];
  diagnosis: RunDiagnosis;
  closure: RunClosure;
  report?: ClosureEvidenceReport;
  repairBrief?: RepairBrief | null;
  readiness?: RuntimeRelayReadinessReport;
  driverCheck?: DriverContractComplianceReport;
  evidenceSource?: EvidenceSource;
  integrationMode?: string;
  targetSupport?: TargetCapabilityReport;
  triggerDecision?: TriggerDecisionReport;
  project?: ProjectProfile;
  projectMemoryRef?: {
    projectId: string;
    recordFile: string;
  };
  closureEligibility?: {
    eligible: boolean;
    blockingReasons: string[];
  };
  failureChain?: RunFailureChain | null;
  repairStrategy?: RunRepairStrategy | null;
  handoff?: HandoffArtifact | null;
  autoloop?: {
    session: AutoloopSession;
    attempts: Array<
      AutoloopAttempt & {
        repairOutcome?: RepairOutcome | null;
      }
    >;
    decision: AutoloopStopDecision | null;
  } | null;
  diff?: {
    baselineRunId: string;
    currentRunId: string;
    changed: RunDiffItem[];
  };
  integrity: IntegrityReport;
  checkpoints: RunCheckpoint[];
  generatedAt: string;
}

export interface StartRunInput {
  label?: string;
  target?: TestTarget;
  metadata?: Record<string, unknown>;
}

export interface StartStepInput {
  name?: string;
  kind?: StepKind;
  route?: string;
  metadata?: Record<string, unknown>;
}

export interface EndStepInput {
  status?: StepStatus;
  metadata?: Record<string, unknown>;
}

export interface EndRunInput {
  status?: RunStatus;
  metadata?: Record<string, unknown>;
}

export interface IngestBatchEnvelope {
  runId?: string;
  stepId?: string;
  records?: RelayLogInput[];
}

export interface OrchestrationStartInput extends StartRunInput {
  scenario?: string;
  baselineRunId?: string;
}

export interface AutoloopStartInput {
  triggerReason?: string;
  target?: TestTarget;
  scenario?: string;
  entryContext?: Record<string, unknown>;
  baselineRunId?: string;
  maxAttempts?: number;
}

export interface AutoloopSession {
  id: string;
  runId: string;
  status: AutoloopStatus;
  triggerReason: string;
  targetSurface: TestTarget;
  attemptCount: number;
  maxAttempts: number;
  startedAt: string;
  endedAt: string;
  entryContext: Record<string, unknown>;
}

export interface AutoloopAttempt {
  id: string;
  sessionId: string;
  attemptIndex: number;
  baselineRunId: string;
  currentRunId: string;
  diagnosisSnapshot: RunDiagnosis | null;
  repairPlanSummary: string;
  result: string;
  createdAt: string;
  completedAt: string;
}

export interface AutoloopStopDecision {
  status: AutoloopDecisionStatus;
  reason: string;
  confidence: number;
  evidence: string[];
  shouldContinue: boolean;
  nextAction: string;
}

export interface AutoloopAttemptStartInput {
  baselineRunId?: string;
  currentRunId?: string;
}

export interface AutoloopAttemptCompleteInput {
  result?: string;
  stopDecision?: AutoloopStopDecision;
}

export interface CheckpointInput {
  name?: string;
  stepId?: string;
  metadata?: Record<string, unknown>;
}

export interface RepairBrief {
  autoloopId: string;
  attemptId: string;
  dominantFailureStep: TestStep | null;
  targetFilesHint: string[];
  rootCauseHints: RootCauseHint[];
  requiredSignals: string[];
  repairScope: "integration_first" | "runtime_bug_fix" | "regression_containment" | "evidence_insufficient";
  applicabilityStatus: TargetSupportStatus;
  blockingReasons: string[];
  recommendedIntegrationMode: string;
  successCriteria: string[];
}

export interface RepairOutcome {
  changedFiles: string[];
  assumptionDelta: string[];
  riskLevel: RepairRiskLevel;
  notes: string;
}

export interface BugCollectionReport {
  runId: string;
  status: BugCollectionStatus;
  integrity: IntegrityReport;
  timelineHotSpots: TimelineHotspot[];
  topIncidents: RelayIncident[];
  firstFailure: TimelineHotspot | null;
  signalGaps: string[];
  recommendedCollectionFixes: string[];
}

export interface MiniappIntegrationReport {
  wrapperCoverage: number;
  patchCoverage: number;
  routeCoverage: number;
  lifecycleCoverage: number;
  networkCoverage: number;
  integrationMode: "wrapper-first" | "patch-enhanced" | "manual-fallback";
  consoleReady: boolean;
  lifecycleReady: boolean;
  routeReady: boolean;
  networkReady: boolean;
  autoloopEligible: boolean;
  blockingReasons: string[];
  warnings: string[];
}

export interface MiniappProjectIntegrationReport {
  target: "miniapp";
  status: TargetSupportStatus;
  appEntry: string;
  pageCoverage: number;
  componentCoverage: number;
  wrapperCoverage: number;
  patchCoverage: number;
  routeCoverage: number;
  lifecycleCoverage: number;
  networkCoverage: number;
  blockingIssues: string[];
  recommendedActions: string[];
}

export interface MiniappSignalReport {
  runId: string;
  setDataCoverage: number;
  routeTransitions: number;
  lifecycleContinuity: "complete" | "partial" | "missing";
  requestToUiContinuity: "complete" | "partial" | "missing";
  warnings: string[];
}

export interface BindingState {
  runId: string;
  stepId: string;
  autoCaptureActive: boolean;
}

export interface RelaySelfCheck {
  transportAvailable: boolean;
  autoCaptureActive: boolean;
  runBound: boolean;
  stepBound: boolean;
  capturedCapabilities: string[];
  warnings: string[];
}

export interface TargetCapabilityReport {
  target: string;
  status: TargetSupportStatus;
  driverAvailable: boolean;
  sdkAvailable: boolean;
  signalReadiness: "ready" | "verify_required" | "collection_incomplete" | "unsupported";
  reasonCode: string;
  reason: string;
  recommendedAction: string;
  supportedTargets: SupportedTarget[];
  currentCapabilities: string[];
  recommendedIntegrationMode?: string;
  evidenceSource: EvidenceSource;
}

export interface WebIntegrationReport {
  target: "web";
  framework: WebFramework;
  entrypoints: ProjectEntrypoint[];
  routeMode: string;
  networkLayerCandidates: string[];
  errorBoundaryCandidates: string[];
  relayInsertionReadiness: "ready" | "partial" | "blocked";
  blockingIssues: string[];
  recommendedActions: string[];
}

export interface TriggerDecisionReport {
  target: string;
  phase: TriggerPhase;
  reason: string;
  runtimeImpact: boolean;
  mustTrigger: boolean;
  status: "must_trigger" | "optional" | "skip_allowed" | "unsupported" | "inapplicable";
  reasonCode: string;
  decisionReason: string;
  recommendedCommand: string;
  blockingReason: string;
}

export interface RuntimeRelayReadinessReport {
  target: string;
  maturity: IntegrationMaturity;
  evidenceSource: EvidenceSource;
  evidenceLevel: "project_only" | "runtime_verified";
  requiredSignals: string[];
  availableSignals: string[];
  missingSignals: string[];
  autoloopEligible: boolean;
  blockingReasons: string[];
  recommendedIntegrationMode: string;
  bestPracticeCompliant: boolean;
  verifiedRunId?: string;
}

export interface ProjectProfile {
  projectId: string;
  projectRoot: string;
  target: SupportedTarget;
  framework: WebFramework | "miniapp";
  integrationMode: string;
  knownEntrypoints: string[];
  knownSignalGaps: string[];
  lastVerifiedAt: string;
}

export interface ProjectMemoryRecord {
  projectId: string;
  runId: string;
  autoloopId?: string;
  dominantFailureChain: string[];
  resolvedFingerprints: string[];
  regressedFingerprints: string[];
  integrationFixes: string[];
  repairOutcomes: RepairOutcome[];
  recordedAt: string;
  recordFile?: string;
}

export interface ProjectKnowledgeSnapshot {
  project: ProjectProfile;
  records: ProjectMemoryRecord[];
  recentRunIds: string[];
  knownSignalGaps: string[];
  resolvedFingerprints: string[];
  regressedFingerprints: string[];
}

export interface RunFailureChain {
  runId: string;
  dominantFailureStep: string;
  firstFailureSequence: number;
  evidence: string[];
  incidentFingerprints: string[];
  rootCauseHints: RootCauseHint[];
}

export interface RunRepairStrategy {
  runId: string;
  strategy: "integration_first" | "runtime_bug_fix" | "regression_containment" | "evidence_insufficient";
  summary: string;
  reasons: string[];
  successCriteria: string[];
}

export interface HandoffArtifact {
  project: ProjectProfile | null;
  run: TestRun;
  closure: RunClosure;
  verdict?: ClosureVerdict;
  integrity: IntegrityReport;
  dominantFailureChain: RunFailureChain | null;
  topIncidents: RelayIncident[];
  signalGaps: string[];
  attemptHistory: Array<
    AutoloopAttempt & {
      repairOutcome?: RepairOutcome | null;
    }
  >;
  whatWasTried: string[];
  whyStopped: string;
  recommendedNextActions: string[];
}

export interface DriverAgnosticContract {
  target: SupportedTarget;
  driver: ExternalDriverType;
  positioning: "reference_driver" | "external_agent_driver";
  requiredOrder: string[];
  requiredApiCalls: string[];
  requiredSignals: string[];
  sdkBindingContract: {
    mustBindRun: boolean;
    mustBindStep: boolean;
    preferredAdapters: string[];
  };
  closureContract: {
    mustCheckCollection: boolean;
    mustCheckClosure: boolean;
    mustCheckHandoffOnFailure: boolean;
  };
  stopConditions: string[];
  forbiddenClaims: string[];
}

export interface DriverContractComplianceReport {
  runId: string;
  target: SupportedTarget;
  driver: ExternalDriverType;
  contract: DriverAgnosticContract;
  compliant: boolean;
  missingRequirements: string[];
  warnings: string[];
  observedSignals: string[];
  runBoundEventCoverage: number;
  stepBoundEventCoverage: number;
}

export interface ClosureVerdict {
  status: ClosureVerdictStatus;
  reason: string;
  confidence: number;
  nextAction: string;
}

export interface ClosureEvidenceReport {
  runId: string;
  target: string;
  support: TargetCapabilityReport;
  triggerDecision: TriggerDecisionReport;
  projectVerify: {
    mode: "project_only" | "runtime_verified";
    projectId: string;
    status: "supported" | "partial" | "unsupported" | "inapplicable";
    closureEligible: boolean;
    autoloopEligible: boolean;
    blockingReasons: string[];
    recommendedAction: string;
  };
  runtimeReadiness: RuntimeRelayReadinessReport | null;
  driverCheck: DriverContractComplianceReport | null;
  collection: BugCollectionReport | null;
  diagnosis: RunDiagnosis | null;
  closure: RunClosure | null;
  handoff?: HandoffArtifact | null;
  verdict: ClosureVerdict;
}

export interface TaskEnforcementReport {
  target: string;
  phase: TriggerPhase;
  runtimeImpact: boolean;
  closureClaim: boolean;
  mustUseSkill: boolean;
  canClaimDone: boolean;
  blockingReasons: string[];
  requiredEvidence: string[];
  recommendedCommand: string;
}
