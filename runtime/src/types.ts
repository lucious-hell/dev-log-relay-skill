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
export type MiniappDriverType = "devtools-automator" | "external-agent" | "generic-miniapp-driver";
export type ClosureVerdictStatus = "resolved" | "unresolved" | "inconclusive" | "unsupported" | "integration_required";
export type EvidenceLayer = "project_structure" | "instrumentation_attached" | "runtime_events_observed" | "user_flow_closed";
export type TargetDetectionStatus = "detected_supported" | "detected_partial" | "unknown_but_observable" | "unsupported" | "inapplicable";
export type VerificationFailureFamily =
  | "integration_failure"
  | "observation_failure"
  | "business_failure"
  | "regression_failure"
  | "unsupported_target"
  | "inapplicable_runtime";
export type FailureReasonCode =
  | "integration_missing"
  | "instrumentation_not_attached"
  | "runtime_not_observed"
  | "collection_incomplete"
  | "route_not_observed"
  | "network_not_observed"
  | "lifecycle_not_observed"
  | "render_not_observed"
  | "page_registration_unresolved"
  | "workspace_resolution_ambiguous"
  | "network_failed"
  | "resource_failed"
  | "render_failed"
  | "state_not_reached"
  | "assertion_failed"
  | "regression_detected"
  | "driver_contract_failed"
  | "unsupported_target"
  | "inapplicable_runtime"
  | "low_confidence";
export type ScenarioObservationStatus = "passed" | "failed" | "partially_observed" | "not_observed";
export type ScenarioAssertionStatus = "passed" | "failed" | "not_observed";
export type ScenarioRiskLevel = "low" | "medium" | "high" | "critical";
export type BaselinePolicy = "always" | "when_passed" | "manual";
export type ScenarioTemplateSource = "builtin" | "project_local";
export type MiniappExecutionStage =
  | "resolve_project"
  | "resolve_driver"
  | "prepare_run"
  | "execute_actions"
  | "validate_scenario"
  | "finalize_closure";
export type MiniappExecutionStopReason =
  | "driver_resolution_failed"
  | "driver_bootstrap_failed"
  | "driver_execution_interrupted"
  | "bridge_payload_invalid"
  | "bridge_action_incomplete"
  | "runtime_feed_incomplete"
  | "scenario_validation_failed"
  | "closure_hold"
  | "completed";

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

export interface TargetSignal {
  kind: "file" | "dependency" | "config" | "code_pattern" | "runtime_hint";
  value: string;
  weight: number;
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

export interface ScenarioStep {
  id: string;
  kind:
    | "launch"
    | "enter_page"
    | "route_change"
    | "tap"
    | "input"
    | "pull_down_refresh"
    | "switch_tab"
    | "navigate_back"
    | "share_entry"
    | "retry"
    | "wait_request_start"
    | "wait_request_complete"
    | "wait_lifecycle"
    | "wait_render"
    | "wait_state"
    | "wait_setData"
    | "assert_field"
    | "assert_state"
    | "assert_data_key"
    | "assert_ui_state"
    | "assert_route_stack"
    | "assert_request_to_setData_continuity"
    | "assert_absent"
    | "assert_fallback";
  route?: string;
  eventPhase?: EventPhase;
  match?: string;
  field?: string;
  value?: string;
  timeoutMs?: number;
  optional?: boolean;
}

export interface MiniappActionInput {
  id: string;
  type: "launch" | "enter_page" | "tap" | "input" | "pull_down_refresh" | "switch_tab" | "navigate_back" | "share_entry" | "retry";
  pagePath?: string;
  selector?: string;
  value?: string;
  route?: string;
  metadata?: Record<string, unknown>;
}

export interface ScenarioAssertion {
  id: string;
  type:
    | "field_exists"
    | "state_reached"
    | "state_not_reached"
    | "continuity"
    | "fallback_triggered"
    | "exclusive_state"
    | "data_key_exists"
    | "ui_state"
    | "route_stack"
    | "request_to_setData_continuity";
  match?: string;
  value?: string;
  withinSteps?: string[];
  blocking?: boolean;
}

export interface ScenarioStateTransition {
  from: string;
  to: string;
  evidenceMatch?: string;
}

export interface ScenarioSpec {
  id: string;
  target: SupportedTarget;
  flow?: string;
  pageKey?: string;
  pagePath?: string;
  entry: {
    route?: string;
    page?: string;
  };
  actions?: MiniappActionInput[];
  steps: ScenarioStep[];
  expectations: string[];
  fallbacks: string[];
  assertions: ScenarioAssertion[];
  stateTransitions: ScenarioStateTransition[];
  templateName?: string;
  riskLevel?: ScenarioRiskLevel;
  blockingByDefault?: boolean;
  baselinePolicy?: BaselinePolicy;
  preconditions?: string[];
  postconditions?: string[];
  retryPolicy?: {
    maxAttempts?: number;
    timeoutMs?: number;
    allowPartial?: boolean;
  };
}

export interface ScenarioAssertionResult {
  id: string;
  status: ScenarioAssertionStatus;
  reason: string;
  matchedSequences: number[];
}

export interface StateTransitionReport {
  expectedTransitions: ScenarioStateTransition[];
  observedTransitions: Array<{
    from: string;
    to: string;
    matchedSequence: number;
  }>;
  missingTransitions: ScenarioStateTransition[];
}

export interface ScenarioRunReport {
  runId: string;
  scenarioId: string;
  target: SupportedTarget;
  pageKey?: string;
  blocking?: boolean;
  baselineComparable?: boolean;
  templateSource?: ScenarioTemplateSource;
  baselineKey?: string;
  blockingFailures?: string[];
  status: ScenarioObservationStatus;
  actionExecution?: Array<{
    actionId: string;
    actionType: MiniappActionInput["type"];
    status: "executed" | "skipped" | "failed" | "not_applicable";
    reason: string;
  }>;
  observedSteps: Array<{
    stepId: string;
    status: ScenarioObservationStatus;
    matchedSequence: number;
    reason: string;
  }>;
  assertions: ScenarioAssertionResult[];
  stateReport: StateTransitionReport;
  evidenceSequences: number[];
  missingEvidence: string[];
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
  reasonCode?: FailureReasonCode | string;
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
  failureStage: EvidenceLayer;
  failureFamily?: VerificationFailureFamily;
  reasonCode: FailureReasonCode | string;
  blockingReasons?: string[];
  releaseDecision?: ReleaseDecisionReport;
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
  scenario?: ScenarioRunReport | null;
  miniappObservation?: MiniappSignalReport | null;
  baseline?: ScenarioBaselineSnapshot | null;
  reportSummaries?: {
    shortHuman: ShortHumanSummary;
    failureOnePager: FailureOnePager;
    prComment: PRCommentSummary;
    issueSummary: IssueSummary;
    baselineCompare: BaselineCompareSummary | null;
  };
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
  failureStage?: EvidenceLayer;
  repairMode?: "integration_first" | "runtime_signal_fix" | "state_machine_fix" | "regression_containment" | "evidence_insufficient";
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
  structureStatus?: "complete" | "partial" | "missing";
  workspaceRoot?: string;
  appEntry: string;
  projectConfigEntry?: string;
  sourceRoot?: string;
  resolvedMiniappRoot?: string;
  entries?: string[];
  pageCoverage: number;
  pageResolutionCoverage?: number;
  pageMap?: string[];
  resolvedPageFiles?: string[];
  subPackages?: string[];
  componentCoverage: number;
  wrapperCoverage: number;
  patchCoverage: number;
  routeCoverage: number;
  lifecycleCoverage: number;
  networkCoverage: number;
  pageRegistrationResolution?: "resolved" | "partial" | "unresolved";
  structureAmbiguities?: string[];
  blockingIssues: string[];
  recommendedActions: string[];
}

export interface MiniappSignalReport {
  runId: string;
  setDataCoverage: number;
  routeTransitions: number;
  lifecycleContinuity: "complete" | "partial" | "missing";
  requestToUiContinuity: "complete" | "partial" | "missing";
  observedPages: string[];
  lifecycleHooks: string[];
  stateSignatures: string[];
  actionStepCount: number;
  actionsObserved?: string[];
  requestCount: number;
  attributedRequestCount: number;
  requestAttributionCoverage: number;
  assertionEvidence?: MiniappAssertionEvidence[];
  scenarioBlockingStatus?: "passed" | "failed" | "missing";
  observationReady: boolean;
  evidenceLayer: EvidenceLayer;
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
  closureEligible?: boolean;
  autoloopEligible?: boolean;
}

export interface TargetDetectionReport {
  detectedTarget: SupportedTarget | "unknown" | "backend";
  status: TargetDetectionStatus;
  confidence: number;
  signals: TargetSignal[];
  blockingIssues: string[];
  recommendedAction: string;
  projectRoot: string;
  supportedTarget: SupportedTarget | null;
  framework?: WebFramework | "miniapp";
}

export interface ProjectResolutionReport {
  target: SupportedTarget | "unknown" | "backend";
  status: TargetDetectionStatus;
  confidence: number;
  framework?: WebFramework | "miniapp";
  workspaceRoot: string;
  resolvedProjectRoot: string;
  sourceRoot?: string;
  entrypoints: ProjectEntrypoint[];
  routeLayerCandidates: string[];
  networkLayerCandidates: string[];
  errorBoundaryCandidates: string[];
  pageRegistrations: string[];
  packageTopology: {
    monorepo: boolean;
    workspacePackage?: string;
    apps?: string[];
    packages?: string[];
  };
  blockingIssues: string[];
  recommendedActions: string[];
  recognized: string[];
  notRecognized: string[];
  blindSpots: string[];
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
  evidenceLayer: EvidenceLayer;
  requiredSignals: string[];
  availableSignals: string[];
  missingSignals: string[];
  autoloopEligible: boolean;
  blockingReasons: string[];
  recommendedIntegrationMode: string;
  bestPracticeCompliant: boolean;
  verifiedWhat: string[];
  notVerifiedYet: string[];
  releaseEligible: boolean;
  verifiedRunId?: string;
}

export interface RunActionBoundary {
  id: string;
  runId: string;
  stepId: string;
  actionType: StepKind;
  startedSequence: number;
  endedSequence: number;
  route: string;
  pagePath?: string;
  triggerSource?: "reference_driver" | "external_agent" | "runtime_observed";
  completionStatus?: "executed" | "partial" | "failed" | "timeout" | "bridge_required";
  timeoutMs?: number;
  retryCount?: number;
  actionId?: string;
}

export interface StateSnapshot {
  runId: string;
  stepId: string;
  sequence: number;
  scope: "render" | "miniapp_setData" | "state" | "lifecycle";
  signature: string;
  fields: string[];
  pagePath?: string;
  componentPath?: string;
  dataKeys?: string[];
  derivedUiState?: string[];
}

export interface RequestAttribution {
  runId: string;
  requestSequence: number;
  relatedStepId: string;
  route: string;
  downstreamRenderSequence?: number;
  downstreamLifecycleSequence?: number;
  downstreamStateSequence?: number;
  attributionStatus: "attributed" | "missing_render" | "missing_lifecycle" | "missing_state" | "missing_step";
}

export interface MiniappLifecycleChain {
  runId: string;
  pagePath: string;
  hooks: string[];
  continuityStatus: "complete" | "partial" | "missing";
}

export interface MiniappAssertionEvidence {
  assertionId: string;
  status: ScenarioAssertionStatus;
  matchedSignals: string[];
  blocking: boolean;
}

export interface MiniappActionResult {
  actionId: string;
  type: MiniappActionInput["type"];
  pagePath?: string;
  success: boolean;
  reason: string;
  completionStatus?: "executed" | "partial" | "failed" | "timeout" | "bridge_required";
  retries?: number;
  timeoutMs?: number;
  emittedEvents?: RelayLogInput[];
}

export interface DriverResolutionReport {
  target: "miniapp";
  driver: MiniappDriverType;
  executable: boolean;
  stage: MiniappExecutionStage;
  status: "resolved" | "bridge_required" | "driver_not_available" | "project_not_ready";
  reason: string;
  checks: string[];
  projectRoot: string;
}

export interface ExecutionLedgerItem {
  actionId: string;
  actionType: MiniappActionInput["type"];
  pagePath?: string;
  stage: MiniappExecutionStage;
  completionStatus: "executed" | "partial" | "failed" | "timeout" | "bridge_required";
  success: boolean;
  reason: string;
  retries: number;
  timeoutMs: number;
  emittedEventCount: number;
}

export interface ExecutionLedger {
  runId: string;
  items: ExecutionLedgerItem[];
  completedActions: number;
  failedActions: number;
  timeoutActions: number;
  bridgeActions: number;
}

export interface MiniappExecutionCoordinatorResult {
  runId: string;
  driver: MiniappDriverType;
  stage: MiniappExecutionStage;
  status: "executed" | "driver_not_available" | "bridge_required";
  stopReason?: MiniappExecutionStopReason;
  driverResolution: DriverResolutionReport;
  executionLedger: ExecutionLedger;
  actionResults: MiniappActionResult[];
  reason: string;
  retrySummary?: {
    attemptedActions: number;
    retriedActions: number;
    maxRetriesObserved: number;
  };
  driverFailureSummary?: string[];
}

export interface ProjectProfile {
  projectId: string;
  projectRoot: string;
  target: SupportedTarget;
  framework: WebFramework | "miniapp";
  integrationMode: string;
  knownEntrypoints: string[];
  knownSignalGaps: string[];
  scenarioCapabilities?: string[];
  supportedEvidenceLayers?: EvidenceLayer[];
  knownBaselines?: string[];
  knownFailurePatterns?: string[];
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
  scenarioResults?: string[];
  failureStage?: EvidenceLayer;
  handoffReason?: string;
  effectiveFixPatterns?: string[];
  blockingScenarioPasses?: string[];
  blockingScenarioFailures?: string[];
  driverFailurePatterns?: string[];
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
  recentScenarioResults?: string[];
  recentFailureStages?: EvidenceLayer[];
}

export interface RunFailureChain {
  runId: string;
  originStage: EvidenceLayer;
  dominantFailureStep: string;
  firstFailureSequence: number;
  evidence: string[];
  incidentFingerprints: string[];
  rootCauseHints: RootCauseHint[];
  linkedNetworkEvents?: number[];
  linkedLifecycleEvents?: number[];
  linkedStateTransitions?: string[];
  suspectedLayer?: "integration" | "network" | "routing" | "state_machine" | "render" | "data_consumption";
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
  failureStage?: EvidenceLayer;
}

export interface ReleaseDecisionReport {
  decision: "ship" | "hold" | "manual_review_required";
  riskLevel: "low" | "medium" | "high" | "critical";
  blockingItems: string[];
  nonBlockingItems: string[];
  confidence: number;
  evidenceLayer: EvidenceLayer;
  why: string[];
  baselineRefs?: string[];
  blockingScenarioIds?: string[];
}

export interface ExecutableHandoffArtifact {
  project: ProjectProfile | null;
  run: TestRun;
  failureFamily: VerificationFailureFamily;
  failureStage: EvidenceLayer;
  dominantFailureChain: RunFailureChain | null;
  likelyRootLayer: "integration" | "network" | "routing" | "state_machine" | "render" | "data_consumption" | "unknown";
  relatedPages: string[];
  relatedRequests: string[];
  relatedLifecycleHooks: string[];
  whatWasVerified: string[];
  whatWasNotVerified: string[];
  whatWasTried: string[];
  recommendedInvestigationEntry: string[];
  recommendedNextValidation: string[];
  recommendedFixDirection: string[];
  driverFailureSummary?: string[];
  baselineCompareSummary?: BaselineCompareSummary | null;
  releaseDecision: ReleaseDecisionReport;
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

export interface MiniappDriverContract {
  target: "miniapp";
  driver: MiniappDriverType;
  positioning: "reference_driver" | "external_agent_driver";
  executable: boolean;
  requiredOrder: string[];
  requiredApiCalls: string[];
  requiredSignals: string[];
  requiredActions: MiniappActionInput["type"][];
  sdkBindingContract: {
    mustBindRun: boolean;
    mustBindStep: boolean;
    mustEmitActionBoundary: boolean;
    preferredAdapters: string[];
  };
  closureContract: {
    mustCheckCollection: boolean;
    mustCheckScenario: boolean;
    mustCheckClosure: boolean;
    mustCheckReleaseDecision: boolean;
    mustCheckHandoffOnFailure: boolean;
  };
  stopConditions: string[];
  forbiddenClaims: string[];
}

export type RuntimeDriverContract = DriverAgnosticContract | MiniappDriverContract;

export interface DriverContractComplianceReport {
  runId: string;
  target: SupportedTarget;
  driver: ExternalDriverType | MiniappDriverType;
  contract: RuntimeDriverContract;
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
  evidenceLayer?: EvidenceLayer;
  releaseEligible?: boolean;
}

export interface ClosureEvidenceReport {
  runId: string;
  target: string;
  evidenceLayer?: EvidenceLayer;
  failureFamily?: VerificationFailureFamily;
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
    evidenceLayer?: EvidenceLayer;
  };
  runtimeReadiness: RuntimeRelayReadinessReport | null;
  driverCheck: DriverContractComplianceReport | null;
  collection: BugCollectionReport | null;
  diagnosis: RunDiagnosis | null;
  closure: RunClosure | null;
  handoff?: HandoffArtifact | null;
  scenario?: ScenarioRunReport | null;
  miniappObservation?: MiniappSignalReport | null;
  miniappExecution?: MiniappExecutionCoordinatorResult | null;
  targetSupport?: TargetDetectionReport | null;
  verifiedWhat?: string[];
  notVerifiedYet?: string[];
  releaseEligible?: boolean;
  blockingItems?: string[];
  nonBlockingItems?: string[];
  releaseDecision?: ReleaseDecisionReport;
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

export interface ScenarioBaselineSnapshot {
  runId: string;
  scenarioId: string;
  pageKey?: string;
  baselineKey?: string;
  keyStepSequence: string[];
  requestSequence: string[];
  stateSignatures?: string[];
  stateTransitions: string[];
  assertionResults: Array<{ id: string; status: ScenarioAssertionStatus }>;
  signalPresence: string[];
  evidenceLayer: EvidenceLayer;
}

export interface RequestSequenceBaseline {
  runId: string;
  requests: string[];
}

export interface StateSignatureBaseline {
  runId: string;
  signatures: string[];
}

export interface ScenarioDiffItem {
  kind: "step" | "request" | "state" | "assertion" | "signal";
  key: string;
  status: "added" | "removed" | "changed" | "unchanged";
  baselineValue: string;
  currentValue: string;
}

export interface ShortHumanSummary {
  title: string;
  verdict: ClosureVerdictStatus;
  message: string;
  topFindings: string[];
}

export interface FailureOnePager {
  runId: string;
  failureStage: EvidenceLayer;
  summary: string;
  topIncidents: string[];
  signalGaps: string[];
  nextActions: string[];
}

export interface PRCommentSummary {
  verdict: ClosureVerdictStatus;
  headline: string;
  bullets: string[];
}

export interface IssueSummary {
  title: string;
  severity: "low" | "medium" | "high";
  body: string[];
}

export interface BaselineCompareSummary {
  baselineRunId: string;
  currentRunId: string;
  verdict: ClosureVerdictStatus;
  changedRequests: string[];
  changedStates: string[];
  changedAssertions: string[];
  blockingChanges?: string[];
  nonBlockingChanges?: string[];
}

export interface CiVerificationResult {
  status: "pass" | "manual_review_required" | "hold" | "unsupported";
  failedChecks: string[];
  blockingReasons: string[];
  artifacts: string[];
  baselineRefs?: string[];
  recommendedExitCode: 0 | 2 | 3 | 4;
}

export interface ProjectScenarioCatalogEntry {
  scenario: ScenarioSpec;
  source: ScenarioTemplateSource;
  filePath?: string;
  conflictWith?: string;
}

export interface ProjectScenarioCatalog {
  target?: SupportedTarget;
  scenarios: ProjectScenarioCatalogEntry[];
  sources: string[];
  conflicts: string[];
  recommendations: string[];
}

export interface ProjectBaselineRegistryEntry {
  baselineKey: string;
  source: ScenarioTemplateSource;
  scenarioId: string;
  pageKey?: string;
  target?: SupportedTarget;
  latestSuccess?: ScenarioBaselineSnapshot | null;
  latestFailure?: ScenarioBaselineSnapshot | null;
  failureSummary?: string[];
  filePath?: string;
}

export interface ProjectBaselineRegistry {
  entries: ProjectBaselineRegistryEntry[];
  sources: string[];
}

export interface BlockingScenarioDiff {
  scenarioId: string;
  pageKey?: string;
  blocking: boolean;
  changed: ScenarioDiffItem[];
}

export interface RegressionGateResult {
  baselineRunId: string;
  currentRunId: string;
  blockingDiffs: BlockingScenarioDiff[];
  nonBlockingDiffs: BlockingScenarioDiff[];
  decision: "ship" | "hold" | "manual_review_required";
  baselineRefs: string[];
  failedChecks: string[];
  blockingReasons: string[];
}
