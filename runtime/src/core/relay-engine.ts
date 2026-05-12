import path from "node:path";
import type { RelayConfig } from "../config.js";
import type {
  AutoloopAttemptCompleteInput,
  AutoloopAttemptStartInput,
  AutoloopStopDecision,
  AutoloopStartInput,
  CiVerificationResult,
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
  MiniappAssertionEvidence,
  MiniappDriverContract,
  MiniappDriverType,
  MiniappLifecycleChain,
  MiniappActionInput,
  MiniappActionResult,
  MiniappProjectIntegrationReport,
  MiniappSignalReport,
  ProjectResolutionReport,
  OrchestrationStartInput,
  ProjectKnowledgeSnapshot,
  ProjectMemoryRecord,
  ProjectProfile,
  ReleaseDecisionReport,
  RelayIncident,
  RelayLogEvent,
  RelayLogInput,
  RelaySnapshot,
  RepairBrief,
  RepairOutcome,
  RequestAttribution,
  RuntimeRelayReadinessReport,
  RuntimeDriverContract,
  RootCauseHint,
  RunCheckpoint,
  RunActionBoundary,
  RunClosure,
  RunDiagnosis,
  RunDiffItem,
  RunFailureChain,
  RunFlow,
  RunRepairStrategy,
  RunSummary,
  ScenarioBaselineSnapshot,
  ScenarioDiffItem,
  ScenarioRunReport,
  ScenarioSpec,
  ScenarioAssertionResult,
  StateSnapshot,
  StateTransitionReport,
  ShortHumanSummary,
  FailureOnePager,
  PRCommentSummary,
  IssueSummary,
  BaselineCompareSummary,
  BlockingScenarioDiff,
  MiniappExecutionCoordinatorResult,
  ProjectBaselineRegistry,
  ProjectBaselineRegistryEntry,
  ProjectScenarioCatalog,
  ProjectScenarioCatalogEntry,
  RegressionGateResult,
  ScenarioTemplateSource,
  StartRunInput,
  StartStepInput,
  SupportedTarget,
  TestRun,
  TargetDetectionReport,
    TargetCapabilityReport,
    TaskEnforcementReport,
    VerificationFailureFamily,
    TriggerDecisionReport,
    TriggerPhase,
  TimelineHotspot,
  TimelineItem,
  WebIntegrationReport,
  ExecutableHandoffArtifact,
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

function uniqValues<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function eventMatchesScenarioStep(event: RelayLogEvent, step: ScenarioSpec["steps"][number]): boolean {
  if (step.route && event.route !== step.route) return false;
  if (step.eventPhase && event.phase !== step.eventPhase) return false;
  if (step.match) {
    return event.message.includes(step.match) || event.tags.some((tag) => tag.includes(step.match || ""));
  }
  if (step.kind === "launch") return event.message.includes("launch") || event.tags.includes("app_launch");
  if (step.kind === "enter_page") return event.phase === "navigation" || event.tags.includes("route_transition");
  if (step.kind === "tap") return event.tags.includes("tap") || event.message.includes("tap");
  if (step.kind === "input") return event.tags.includes("input") || event.message.includes("input");
  if (step.kind === "pull_down_refresh") return event.message.includes("refresh") || event.tags.includes("pull_down_refresh");
  if (step.kind === "switch_tab") return event.message.includes("switchTab") || event.tags.includes("switch_tab");
  if (step.kind === "navigate_back") return event.message.includes("navigateBack") || event.tags.includes("navigate_back");
  if (step.kind === "share_entry") return event.message.includes("share") || event.tags.includes("share_entry");
  if (step.kind === "retry") return event.message.includes("retry") || event.tags.includes("retry");
  if (step.kind === "route_change") return event.phase === "navigation";
  if (step.kind === "wait_render") return event.phase === "render";
  if (step.kind === "wait_request_start") return event.phase === "network" && event.network?.stage === "start";
  if (step.kind === "wait_request_complete") {
    return event.phase === "network" && ["success", "fail", "complete"].includes(String(event.network?.stage || ""));
  }
  if (step.kind === "wait_lifecycle") return event.phase === "lifecycle";
  if (step.kind === "wait_setData") return event.tags.includes("setData") || event.message.includes("setData");
  if (
    step.kind === "wait_state" ||
    step.kind === "assert_field" ||
    step.kind === "assert_state" ||
    step.kind === "assert_data_key" ||
    step.kind === "assert_ui_state" ||
    step.kind === "assert_route_stack" ||
    step.kind === "assert_request_to_setData_continuity" ||
    step.kind === "assert_fallback"
  ) {
    return false;
  }
  if (step.kind === "assert_absent") return false;
  return true;
}

function inferMiniappUiState(event: RelayLogEvent): string[] {
  const states = new Set<string>();
  const tags = event.tags || [];
  const message = event.message.toLowerCase();
  if (message.includes("loading") || tags.includes("loading")) states.add("loading");
  if (message.includes("empty") || tags.includes("empty")) states.add("empty");
  if (message.includes("error") || tags.includes("error_state")) states.add("error");
  if (message.includes("retry") || tags.includes("retry")) states.add("retry");
  if (message.includes("fallback") || tags.includes("fallback")) states.add("fallback");
  if (message.includes("ready") || tags.includes("ready")) states.add("ready");
  return Array.from(states);
}

function safeStepName(step: RunDiagnosis["dominantFailureStep"]): string {
  return step ? step.name : "unscoped";
}

const SUPPORTED_TARGETS: SupportedTarget[] = ["web", "miniapp"];

const TEMPLATE_SPECS: ScenarioSpec[] = [
  {
    id: "web_home_cold_start",
    target: "web",
    pageKey: "home",
    templateName: "web_home_cold_start",
    riskLevel: "high",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: { route: "/" },
    steps: [
      { id: "route", kind: "route_change", route: "/" },
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "render", kind: "wait_render", eventPhase: "render", match: "render_complete" },
    ],
    expectations: ["home cold start completes with route, request, and render evidence"],
    fallbacks: [],
    assertions: [{ id: "home_rendered", type: "continuity", match: "render_complete" }],
    stateTransitions: [{ from: "boot", to: "ready", evidenceMatch: "render_complete" }],
  },
  {
    id: "web_list_filter_pagination",
    target: "web",
    pageKey: "list",
    templateName: "web_list_filter_pagination",
    riskLevel: "high",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: { route: "/list" },
    steps: [
      { id: "route", kind: "route_change", route: "/list" },
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "render", kind: "wait_render", eventPhase: "render" },
      { id: "state", kind: "wait_state", match: "page=" },
    ],
    expectations: ["filter and pagination state is reflected after request"],
    fallbacks: [],
    assertions: [{ id: "page_state", type: "state_reached", match: "page=" }],
    stateTransitions: [{ from: "loading", to: "page_ready", evidenceMatch: "page=" }],
  },
  {
    id: "web_detail_open",
    target: "web",
    pageKey: "detail",
    templateName: "web_detail_open",
    riskLevel: "medium",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: {},
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "render", kind: "wait_render", eventPhase: "render", match: "render_complete" },
    ],
    expectations: ["detail page opens and renders after data arrives"],
    fallbacks: [],
    assertions: [{ id: "detail_rendered", type: "continuity", match: "render_complete" }],
    stateTransitions: [{ from: "request_done", to: "detail_ready", evidenceMatch: "render_complete" }],
  },
  {
    id: "web_search_to_result",
    target: "web",
    pageKey: "search",
    templateName: "web_search_to_result",
    riskLevel: "medium",
    blockingByDefault: false,
    baselinePolicy: "when_passed",
    entry: {},
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "render", kind: "wait_render", eventPhase: "render" },
    ],
    expectations: ["search result is rendered after request"],
    fallbacks: [],
    assertions: [{ id: "search_result", type: "continuity", match: "render_complete" }],
    stateTransitions: [{ from: "query_submitted", to: "result_ready", evidenceMatch: "render_complete" }],
  },
  {
    id: "cache_then_revalidate",
    target: "web",
    templateName: "cache_then_revalidate",
    entry: {},
    steps: [
      { id: "route", kind: "route_change" },
      { id: "request", kind: "wait_request_start", eventPhase: "network" },
      { id: "render", kind: "wait_render", eventPhase: "render" },
    ],
    expectations: ["cached content appears before refresh result"],
    fallbacks: [],
    assertions: [{ id: "render_after_request", type: "continuity", match: "render_complete" }],
    stateTransitions: [{ from: "cache", to: "fresh", evidenceMatch: "render_complete" }],
  },
  {
    id: "stale_fallback_on_error",
    target: "web",
    templateName: "stale_fallback_on_error",
    entry: {},
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "fallback", kind: "assert_fallback", match: "fallback" },
    ],
    expectations: ["old data survives request failure"],
    fallbacks: ["stale data fallback"],
    assertions: [{ id: "fallback_triggered", type: "fallback_triggered", match: "fallback" }],
    stateTransitions: [{ from: "request_failed", to: "fallback" }],
  },
  {
    id: "list_pagination_consistency",
    target: "web",
    templateName: "list_pagination_consistency",
    entry: {},
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "state", kind: "wait_state", match: "page=" },
    ],
    expectations: ["page state advances with list request"],
    fallbacks: [],
    assertions: [{ id: "page_state", type: "state_reached", match: "page=" }],
    stateTransitions: [{ from: "page_n", to: "page_n_plus_1", evidenceMatch: "page=" }],
  },
  {
    id: "detail_cache_fast_open",
    target: "web",
    templateName: "detail_cache_fast_open",
    entry: {},
    steps: [{ id: "render", kind: "wait_render", eventPhase: "render" }],
    expectations: ["detail renders without blank gap"],
    fallbacks: [],
    assertions: [{ id: "render_complete", type: "continuity", match: "render_complete" }],
    stateTransitions: [{ from: "open", to: "rendered", evidenceMatch: "render_complete" }],
  },
  {
    id: "retry_after_failure",
    target: "web",
    templateName: "retry_after_failure",
    entry: {},
    steps: [
      { id: "request_fail", kind: "wait_request_complete", eventPhase: "network" },
      { id: "retry", kind: "assert_field", match: "retry" },
    ],
    expectations: ["retry action appears after failure"],
    fallbacks: ["retry"],
    assertions: [{ id: "retry_present", type: "field_exists", match: "retry" }],
    stateTransitions: [{ from: "failed", to: "retry_ready", evidenceMatch: "retry" }],
  },
  {
    id: "loading_empty_error_exclusive",
    target: "web",
    templateName: "loading_empty_error_exclusive",
    entry: {},
    steps: [{ id: "state", kind: "wait_state", match: "loading" }],
    expectations: ["loading/empty/error do not overlap"],
    fallbacks: [],
    assertions: [{ id: "exclusive", type: "exclusive_state", match: "loading|empty|error" }],
    stateTransitions: [],
  },
  {
    id: "request_revision_stability",
    target: "web",
    templateName: "request_revision_stability",
    entry: {},
    steps: [{ id: "request", kind: "wait_request_complete", eventPhase: "network" }],
    expectations: ["request identity remains stable"],
    fallbacks: [],
    assertions: [{ id: "revision", type: "field_exists", match: "requestId" }],
    stateTransitions: [],
  },
  {
    id: "request_to_ui_continuity",
    target: "web",
    templateName: "request_to_ui_continuity",
    entry: {},
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "render", kind: "wait_render", eventPhase: "render" },
    ],
    expectations: ["request completion is followed by UI update"],
    fallbacks: [],
    assertions: [{ id: "continuity", type: "continuity", match: "render_complete" }],
    stateTransitions: [{ from: "request_done", to: "ui_updated", evidenceMatch: "render_complete" }],
  },
  {
    id: "miniapp_home_cold_start",
    target: "miniapp",
    pageKey: "home",
    pagePath: "/pages/home/index",
    templateName: "miniapp_home_cold_start",
    riskLevel: "high",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: { page: "/pages/home/index" },
    actions: [{ id: "launch-home", type: "enter_page", pagePath: "/pages/home/index", route: "/pages/home/index" }],
    steps: [
      { id: "route", kind: "route_change", route: "/pages/home/index" },
      { id: "lifecycle", kind: "wait_lifecycle", eventPhase: "lifecycle", match: "onLoad" },
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "setData", kind: "wait_setData", match: "setData" },
    ],
    expectations: ["home page cold start reaches lifecycle, request, and setData evidence"],
    fallbacks: [],
    assertions: [
      { id: "home_data_ready", type: "request_to_setData_continuity", match: "setData", blocking: true },
      { id: "home_ready_state", type: "ui_state", match: "ready", blocking: true },
    ],
    stateTransitions: [{ from: "boot", to: "ready", evidenceMatch: "ready" }],
  },
  {
    id: "miniapp_request_to_setData_continuity",
    target: "miniapp",
    pageKey: "continuity",
    templateName: "miniapp_request_to_setData_continuity",
    riskLevel: "high",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: {},
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "setData", kind: "wait_state", match: "setData" },
    ],
    expectations: ["request completion is followed by setData/UI update"],
    fallbacks: [],
    assertions: [{ id: "setData_after_request", type: "continuity", match: "setData" }],
    stateTransitions: [{ from: "request_done", to: "setData", evidenceMatch: "setData" }],
  },
  {
    id: "miniapp_home_entry",
    target: "miniapp",
    pageKey: "home",
    templateName: "miniapp_home_entry",
    riskLevel: "high",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: { page: "/pages/home/index" },
    steps: [
      { id: "route", kind: "route_change" },
      { id: "lifecycle", kind: "wait_lifecycle", eventPhase: "lifecycle" },
    ],
    expectations: ["home page route and lifecycle are observed"],
    fallbacks: [],
    assertions: [{ id: "home_lifecycle", type: "continuity", match: "onLoad" }],
    stateTransitions: [{ from: "route_entered", to: "page_loaded", evidenceMatch: "onLoad" }],
  },
  {
    id: "miniapp_search_to_result",
    target: "miniapp",
    pageKey: "search",
    templateName: "miniapp_search_to_result",
    riskLevel: "medium",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: {},
    actions: [{ id: "search-enter", type: "input", pagePath: "/pages/search/index" }],
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "setData", kind: "wait_setData", match: "setData" },
    ],
    expectations: ["search request leads to result state"],
    fallbacks: [],
    assertions: [{ id: "search_result_ready", type: "state_reached", match: "result", blocking: true }],
    stateTransitions: [{ from: "searching", to: "result", evidenceMatch: "result" }],
  },
  {
    id: "miniapp_tab_switch_browse",
    target: "miniapp",
    pageKey: "tab",
    templateName: "miniapp_tab_switch_browse",
    riskLevel: "medium",
    blockingByDefault: false,
    baselinePolicy: "when_passed",
    entry: { page: "/pages/home/index" },
    actions: [{ id: "switch-tab", type: "switch_tab", pagePath: "/pages/home/index" }],
    steps: [
      { id: "route", kind: "route_change" },
      { id: "lifecycle", kind: "wait_lifecycle", eventPhase: "lifecycle" },
      { id: "render", kind: "wait_render", eventPhase: "render" },
    ],
    expectations: ["tab switch leads to route, lifecycle, and render evidence"],
    fallbacks: [],
    assertions: [{ id: "tab_stack", type: "route_stack", match: "/pages/home/index", blocking: false }],
    stateTransitions: [{ from: "switch_tab", to: "tab_ready", evidenceMatch: "/pages/home/index" }],
  },
  {
    id: "miniapp_list_filter_refresh",
    target: "miniapp",
    pageKey: "list",
    templateName: "miniapp_list_filter_refresh",
    riskLevel: "high",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: { page: "/pages/list/index" },
    actions: [{ id: "filter-refresh", type: "pull_down_refresh", pagePath: "/pages/list/index" }],
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "setData", kind: "wait_setData", match: "filter" },
      { id: "state", kind: "wait_state", match: "ready" },
    ],
    expectations: ["request, filter state, and ready state are continuous"],
    fallbacks: [],
    assertions: [
      { id: "filter_data", type: "data_key_exists", match: "filter", blocking: true },
      { id: "request_chain", type: "request_to_setData_continuity", blocking: true },
    ],
    stateTransitions: [{ from: "refreshing", to: "ready", evidenceMatch: "ready" }],
  },
  {
    id: "miniapp_list_pagination",
    target: "miniapp",
    pageKey: "list",
    templateName: "miniapp_list_pagination",
    riskLevel: "high",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: { page: "/pages/list/index" },
    actions: [{ id: "paginate", type: "tap", pagePath: "/pages/list/index" }],
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "page_state", kind: "wait_state", match: "page=" },
    ],
    expectations: ["page state advances after request completion"],
    fallbacks: [],
    assertions: [{ id: "page_state", type: "state_reached", match: "page=", blocking: true }],
    stateTransitions: [{ from: "page_n", to: "page_n_plus_1", evidenceMatch: "page=" }],
  },
  {
    id: "miniapp_list_refresh",
    target: "miniapp",
    pageKey: "list",
    templateName: "miniapp_list_refresh",
    riskLevel: "medium",
    blockingByDefault: false,
    baselinePolicy: "when_passed",
    entry: {},
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "setData", kind: "wait_state", match: "setData" },
    ],
    expectations: ["refresh request is followed by data update"],
    fallbacks: [],
    assertions: [{ id: "refresh_continuity", type: "continuity", match: "setData" }],
    stateTransitions: [{ from: "refresh_requested", to: "refresh_applied", evidenceMatch: "setData" }],
  },
  {
    id: "miniapp_retry_after_failure",
    target: "miniapp",
    pageKey: "retry",
    templateName: "miniapp_retry_after_failure",
    riskLevel: "high",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: {},
    actions: [{ id: "retry-action", type: "retry", pagePath: "/pages/retry/index" }],
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "retry", kind: "retry", match: "retry" },
      { id: "setData", kind: "wait_setData", match: "setData" },
    ],
    expectations: ["retry path reaches successful setData after failure"],
    fallbacks: ["retry"],
    assertions: [
      { id: "retry_present", type: "field_exists", match: "retry", blocking: true },
      { id: "retry_continuity", type: "request_to_setData_continuity", match: "setData", blocking: true },
    ],
    stateTransitions: [{ from: "failed", to: "ready", evidenceMatch: "ready" }],
  },
  {
    id: "miniapp_detail_open",
    target: "miniapp",
    pageKey: "detail",
    templateName: "miniapp_detail_open",
    riskLevel: "medium",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: {},
    steps: [
      { id: "route", kind: "route_change" },
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "setData", kind: "wait_state", match: "setData" },
    ],
    expectations: ["detail request reaches setData/UI update"],
    fallbacks: [],
    assertions: [{ id: "detail_continuity", type: "continuity", match: "setData" }],
    stateTransitions: [{ from: "detail_request", to: "detail_ready", evidenceMatch: "setData" }],
  },
  {
    id: "miniapp_share_return",
    target: "miniapp",
    pageKey: "share",
    templateName: "miniapp_share_return",
    riskLevel: "medium",
    blockingByDefault: false,
    baselinePolicy: "when_passed",
    entry: {},
    actions: [{ id: "share-entry", type: "share_entry", pagePath: "/pages/share/index" }],
    steps: [
      { id: "route", kind: "route_change" },
      { id: "lifecycle", kind: "wait_lifecycle", eventPhase: "lifecycle" },
    ],
    expectations: ["share return re-enters page lifecycle"],
    fallbacks: [],
    assertions: [{ id: "share_returned", type: "route_stack", match: "/pages/share/index", blocking: false }],
    stateTransitions: [{ from: "share", to: "returned", evidenceMatch: "/pages/share/index" }],
  },
  {
    id: "miniapp_cache_then_revalidate",
    target: "miniapp",
    pageKey: "detail",
    templateName: "miniapp_cache_then_revalidate",
    riskLevel: "medium",
    blockingByDefault: false,
    baselinePolicy: "when_passed",
    entry: { page: "/pages/detail/index" },
    steps: [
      { id: "request", kind: "wait_request_start", eventPhase: "network" },
      { id: "render", kind: "wait_render", eventPhase: "render" },
      { id: "fresh", kind: "wait_state", match: "fresh" },
    ],
    expectations: ["cached content settles into fresh content"],
    fallbacks: [],
    assertions: [{ id: "fresh_state", type: "state_reached", match: "fresh", blocking: false }],
    stateTransitions: [{ from: "cache", to: "fresh", evidenceMatch: "fresh" }],
  },
  {
    id: "miniapp_loading_empty_error_exclusive",
    target: "miniapp",
    pageKey: "state",
    templateName: "miniapp_loading_empty_error_exclusive",
    riskLevel: "medium",
    blockingByDefault: false,
    baselinePolicy: "when_passed",
    entry: {},
    steps: [{ id: "state", kind: "wait_state", match: "loading" }],
    expectations: ["loading, empty, and error states stay exclusive"],
    fallbacks: [],
    assertions: [{ id: "exclusive_state", type: "exclusive_state", match: "loading|empty|error", blocking: false }],
    stateTransitions: [],
  },
  {
    id: "miniapp_stale_fallback_on_error",
    target: "miniapp",
    pageKey: "detail",
    templateName: "miniapp_stale_fallback_on_error",
    riskLevel: "medium",
    blockingByDefault: false,
    baselinePolicy: "when_passed",
    entry: { page: "/pages/detail/index" },
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "fallback", kind: "assert_fallback", match: "fallback" },
    ],
    expectations: ["fallback survives when request fails"],
    fallbacks: ["fallback"],
    assertions: [{ id: "fallback", type: "fallback_triggered", match: "fallback", blocking: false }],
    stateTransitions: [{ from: "request_failed", to: "fallback", evidenceMatch: "fallback" }],
  },
  {
    id: "miniapp_route_lifecycle_continuity",
    target: "miniapp",
    pageKey: "route",
    templateName: "miniapp_route_lifecycle_continuity",
    riskLevel: "high",
    blockingByDefault: true,
    baselinePolicy: "when_passed",
    entry: {},
    steps: [
      { id: "route", kind: "route_change" },
      { id: "lifecycle", kind: "wait_lifecycle", eventPhase: "lifecycle" },
    ],
    expectations: ["route change is followed by lifecycle evidence"],
    fallbacks: [],
    assertions: [{ id: "lifecycle_after_route", type: "continuity", match: "onLoad" }],
    stateTransitions: [{ from: "route_changed", to: "lifecycle_started", evidenceMatch: "onLoad" }],
  },
];

export class RelayEngine {
  private readonly queue: PriorityQueue;
  private readonly events: EventStore;
  private readonly incidents: IncidentStore;
  private readonly runs: RunStore;
  private readonly orchestrations: OrchestrationStore;
  private readonly autoloops: AutoloopStore;
  private readonly workspaceRoot: string;
  private readonly projectMemory: ProjectMemoryStore;
  private readonly snapshots = new Map<string, RelaySnapshot>();
  private readonly snapshotOrder: string[] = [];
  private readonly scenarioReports = new Map<string, ScenarioRunReport>();
  private readonly scenarioSpecs = new Map<string, ScenarioSpec>();
  private readonly scenarioSources = new Map<string, ProjectScenarioCatalogEntry>();
  private readonly baselineSnapshots = new Map<string, ScenarioBaselineSnapshot>();
  private readonly baselineRegistry = new Map<string, ProjectBaselineRegistryEntry>();
  private readonly actionBoundaries = new Map<string, RunActionBoundary[]>();
  private readonly stateSnapshots = new Map<string, StateSnapshot[]>();
  private readonly requestAttributions = new Map<string, RequestAttribution[]>();
  private readonly miniappExecutions = new Map<string, MiniappExecutionCoordinatorResult>();

  constructor(private readonly config: RelayConfig) {
    this.queue = new PriorityQueue(config.maxPendingEvents);
    this.events = new EventStore(config.maxBufferedEvents);
    this.incidents = new IncidentStore();
    this.runs = new RunStore();
    this.orchestrations = new OrchestrationStore(config.artifactDir);
    this.autoloops = new AutoloopStore();
    this.workspaceRoot = process.cwd();
    this.projectMemory = new ProjectMemoryStore(config.projectMemoryDir);
    for (const spec of TEMPLATE_SPECS) {
      this.scenarioSpecs.set(spec.id, spec);
      this.scenarioSources.set(spec.id, { scenario: spec, source: "builtin" });
    }
    void this.loadProjectScenarios();
    void this.loadProjectBaselines();
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
      this.captureDerivedRunFacts(run.id);
      void this.syncProjectMemoryForRun(run.id);
    }
    return run;
  }

  startStep(runId: string, input: StartStepInput) {
    return this.runs.startStep(runId, input, this.events.assignSequence());
  }

  endStep(runId: string, stepId: string, input: EndStepInput) {
    const step = this.runs.endStep(runId, stepId, input, this.events.assignSequence());
    if (step) {
      this.captureActionBoundaries(runId);
    }
    return step;
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

  listScenarioTemplates(target?: SupportedTarget): ScenarioSpec[] {
    return Array.from(this.scenarioSpecs.values()).filter((spec) => !target || spec.target === target);
  }

  listProjectScenarioCatalog(target?: SupportedTarget): ProjectScenarioCatalog {
    const scenarios = Array.from(this.scenarioSources.values()).filter((entry) => !target || entry.scenario.target === target);
    return {
      target,
      scenarios,
      sources: uniqValues(scenarios.map((entry) => entry.source)),
      conflicts: scenarios.filter((entry) => Boolean(entry.conflictWith)).map((entry) => `${entry.scenario.id}:${entry.conflictWith}`),
      recommendations: scenarios.length > 0 ? [] : ["Add scenario files under tooling/scenarios or use built-in templates."],
    };
  }

  getScenarioTemplate(templateName: string, target?: SupportedTarget): ScenarioSpec | null {
    const normalized = String(templateName || "").trim();
    if (!normalized) return null;
    return this.listScenarioTemplates(target).find((spec) => spec.id === normalized || spec.templateName === normalized) || null;
  }

  inspectScenarioTemplate(templateName: string, target?: SupportedTarget) {
    const normalized = String(templateName || "").trim();
    const catalog = this.listProjectScenarioCatalog(target);
    const match = catalog.scenarios.find((entry) => entry.scenario.id === normalized || entry.scenario.templateName === normalized) || null;
    return {
      templateName: normalized,
      found: Boolean(match),
      scenario: match?.scenario || null,
      resolvedFrom: match?.source || "",
      sources: catalog.sources,
      conflicts: catalog.conflicts.filter((item) => item.startsWith(`${normalized}:`) || item.includes(`:${normalized}`)),
      recommendations:
        match
          ? []
          : ["Check tooling/scenarios/*.json", "Use relay scenario list --target <target> to inspect available templates."],
    };
  }

  validateScenario(runId: string, spec: ScenarioSpec): ScenarioRunReport | null {
    const run = this.runs.getRun(runId);
    if (!run) return null;
    const events = this.events.listByRun(runId).slice().sort((left, right) => left.sequence - right.sequence);
    const actionBoundaries = this.captureActionBoundaries(runId);
    const stateSnapshots = this.captureStateSnapshots(runId);
    const requestAttribution = this.captureRequestAttribution(runId);
    let cursor = 0;
    const observedSteps = spec.steps.map((step) => {
      const matched = events.find((event) => event.sequence > cursor && eventMatchesScenarioStep(event, step));
      if (matched) {
        cursor = matched.sequence;
      }
      return {
        stepId: step.id,
        status: matched ? "passed" : step.optional ? "partially_observed" : "not_observed",
        matchedSequence: matched?.sequence || 0,
        reason: matched ? "matched_runtime_event" : step.optional ? "optional_step_missing" : "required_step_missing",
      } satisfies ScenarioRunReport["observedSteps"][number];
    });
    const actionExecution =
      run.target === "miniapp"
        ? (spec.actions || []).map((action) => {
            const matchedBoundary = actionBoundaries.find((boundary) => {
              const step = this.runs.getStep(runId, boundary.stepId);
              const actionType = typeof step?.metadata.actionType === "string" ? String(step.metadata.actionType) : "";
              const pagePath = boundary.pagePath || boundary.route;
              return actionType === action.type && (!action.pagePath || pagePath === action.pagePath);
            });
            return {
              actionId: action.id,
              actionType: action.type,
              status: (matchedBoundary ? "executed" : "failed") as "executed" | "failed",
              reason: matchedBoundary ? "matched_action_boundary" : "action_boundary_missing",
            };
          })
        : undefined;
    const assertionLowerBound = observedSteps.reduce((max, step) => Math.max(max, step.matchedSequence || 0), 0);
    const assertions = spec.assertions.map((assertion) => {
      const matchingEvents = events.filter((event) => {
        if (!assertion.match) return false;
        if (event.sequence < assertionLowerBound) return false;
        return (
          event.message.includes(assertion.match) ||
          event.tags.some((tag) => tag.includes(assertion.match || "")) ||
          Object.keys(event.context || {}).some((key) => key.includes(assertion.match || "")) ||
          Object.values(event.context || {}).some((value) => String(value).includes(assertion.match || ""))
        );
      });
      const matchingStates = stateSnapshots.filter((snapshot) => {
        if (!assertion.match) return false;
        if (snapshot.sequence < assertionLowerBound) return false;
        return (
          snapshot.signature.includes(assertion.match) ||
          snapshot.fields.some((field) => field.includes(assertion.match || "")) ||
          (snapshot.dataKeys || []).some((field) => field.includes(assertion.match || "")) ||
          (snapshot.derivedUiState || []).some((state) => state.includes(assertion.match || ""))
        );
      });
      const routeStackMatched = events.filter((event) => {
        if (!assertion.match) return false;
        const stack = Array.isArray(event.context?.pageStackRoutes) ? (event.context?.pageStackRoutes as unknown[]).map((item) => String(item)) : [];
        return stack.includes(assertion.match);
      });
      const continuityMatched = requestAttribution.filter((item) => item.attributionStatus === "attributed");
      let status: ScenarioAssertionResult["status"] = "failed";
      let reason = "assertion_not_observed";
      let matchedSequences: number[] = [];
      if (assertion.type === "request_to_setData_continuity") {
        status = continuityMatched.length > 0 ? "passed" : "failed";
        reason = continuityMatched.length > 0 ? "continuity_matched" : "continuity_missing";
        matchedSequences = continuityMatched.map((item) => item.requestSequence).slice(0, 5);
      } else if (assertion.type === "route_stack") {
        status = routeStackMatched.length > 0 ? "passed" : "failed";
        reason = routeStackMatched.length > 0 ? "route_stack_matched" : "route_stack_not_observed";
        matchedSequences = routeStackMatched.map((event) => event.sequence).slice(0, 5);
      } else if (assertion.type === "data_key_exists" || assertion.type === "ui_state" || assertion.type === "state_reached") {
        status = matchingStates.length > 0 || matchingEvents.length > 0 ? "passed" : "failed";
        reason = status === "passed" ? "state_assertion_matched" : "state_assertion_not_observed";
        matchedSequences = uniqValues([
          ...matchingStates.map((snapshot) => snapshot.sequence),
          ...matchingEvents.map((event) => event.sequence),
        ]).slice(0, 5);
      } else if (assertion.type === "state_not_reached") {
        status = matchingStates.length === 0 && matchingEvents.length === 0 ? "passed" : "failed";
        reason = status === "passed" ? "state_not_reached_confirmed" : "state_unexpectedly_reached";
        matchedSequences = uniqValues([
          ...matchingStates.map((snapshot) => snapshot.sequence),
          ...matchingEvents.map((event) => event.sequence),
        ]).slice(0, 5);
      } else if (assertion.type === "exclusive_state") {
        const targetStates = String(assertion.match || "")
          .split("|")
          .map((item) => item.trim())
          .filter(Boolean);
        const overlapping = stateSnapshots.filter((snapshot) => {
          const states = snapshot.derivedUiState || [];
          return targetStates.filter((state) => states.includes(state)).length > 1;
        });
        status = overlapping.length === 0 ? "passed" : "failed";
        reason = overlapping.length === 0 ? "exclusive_state_confirmed" : "exclusive_state_violated";
        matchedSequences = overlapping.map((snapshot) => snapshot.sequence).slice(0, 5);
      } else {
        status = matchingEvents.length > 0 ? "passed" : "failed";
        reason = matchingEvents.length > 0 ? "assertion_matched" : "assertion_not_observed";
        matchedSequences = matchingEvents.slice(0, 5).map((event) => event.sequence);
      }
      return {
        id: assertion.id,
        status,
        reason,
        matchedSequences,
      } satisfies ScenarioAssertionResult;
    });
    const observedTransitions = spec.stateTransitions
      .map((transition) => {
        const matchedEvent = events.find(
          (event) =>
            event.sequence >= assertionLowerBound &&
            (event.message.includes(transition.evidenceMatch || transition.to) || event.tags.includes(transition.evidenceMatch || transition.to))
        );
        const matchedState = stateSnapshots.find(
          (snapshot) =>
            snapshot.sequence >= assertionLowerBound &&
            (snapshot.signature.includes(transition.evidenceMatch || transition.to) ||
              snapshot.fields.includes(transition.evidenceMatch || transition.to) ||
              (snapshot.dataKeys || []).includes(transition.evidenceMatch || transition.to) ||
              (snapshot.derivedUiState || []).includes(transition.evidenceMatch || transition.to))
        );
        const matchedSequence = matchedEvent?.sequence || matchedState?.sequence || 0;
        return matchedSequence
          ? {
              from: transition.from,
              to: transition.to,
              matchedSequence,
            }
          : null;
      })
      .filter((item): item is StateTransitionReport["observedTransitions"][number] => Boolean(item));
    const stateReport = {
      expectedTransitions: spec.stateTransitions,
      observedTransitions,
      missingTransitions: spec.stateTransitions.filter(
        (transition) => !observedTransitions.some((item) => item.from === transition.from && item.to === transition.to)
      ),
    };
    const missingEvidence = [
      ...observedSteps.filter((step) => step.status !== "passed").map((step) => `step:${step.stepId}`),
      ...assertions.filter((assertion) => assertion.status !== "passed").map((assertion) => `assertion:${assertion.id}`),
      ...stateReport.missingTransitions.map((transition) => `transition:${transition.from}->${transition.to}`),
    ];
    const status: ScenarioRunReport["status"] =
      missingEvidence.length === 0
        ? "passed"
        : observedSteps.some((step) => step.status === "passed")
          ? "partially_observed"
          : "failed";
    const report: ScenarioRunReport = {
      runId,
      scenarioId: spec.id,
      target: spec.target,
      pageKey: spec.pageKey,
      blocking: Boolean(spec.blockingByDefault),
      baselineComparable: spec.baselinePolicy !== "manual",
      templateSource: this.scenarioSources.get(spec.id)?.source || "builtin",
      baselineKey: `${spec.id}:${spec.pageKey || spec.pagePath || spec.entry.page || spec.entry.route || "default"}`,
      blockingFailures:
        spec.blockingByDefault
          ? missingEvidence.filter((item) => {
              if (!item.startsWith("assertion:")) return true;
              const assertionId = item.slice("assertion:".length);
              return Boolean(spec.assertions.find((assertion) => assertion.id === assertionId && assertion.blocking !== false));
            })
          : [],
      status,
      actionExecution,
      observedSteps,
      assertions,
      stateReport,
      evidenceSequences: uniqValues([
        ...observedSteps.map((step) => step.matchedSequence).filter(Boolean),
        ...assertions.flatMap((assertion) => assertion.matchedSequences),
      ]),
      missingEvidence,
    };
    this.scenarioReports.set(runId, report);
    this.scenarioSpecs.set(spec.id, spec);
    this.captureDerivedRunFacts(runId);
    return report;
  }

  getScenarioReport(runId: string): ScenarioRunReport | null {
    return this.scenarioReports.get(runId) || null;
  }

  captureBaseline(runId: string, scenarioId?: string): ScenarioBaselineSnapshot | null {
    const scenario = this.getScenarioReport(runId);
    const run = this.runs.getRun(runId);
    if (!run) return null;
    const integrity = this.listRunIntegrity(runId);
    const events = this.events.listByRun(runId);
    const snapshot: ScenarioBaselineSnapshot = {
      runId,
      scenarioId: scenarioId || scenario?.scenarioId || "default",
      pageKey: scenario?.pageKey,
      baselineKey: `${scenarioId || scenario?.scenarioId || "default"}:${scenario?.pageKey || "default"}`,
      keyStepSequence: this.runs.listSteps(runId).map((step) => `${step.kind}:${step.name}`),
      requestSequence: events
        .filter((event) => event.phase === "network")
        .map((event) => `${event.network?.method || "GET"} ${event.network?.url || event.message}`),
      stateSignatures: this.captureStateSnapshots(runId).map((snapshot) => snapshot.signature),
      stateTransitions: scenario?.stateReport.observedTransitions.map((item) => `${item.from}->${item.to}`) || [],
      assertionResults: scenario?.assertions.map((assertion) => ({ id: assertion.id, status: assertion.status })) || [],
      signalPresence: integrity.capturedCapabilities,
      evidenceLayer: scenario?.status === "passed" ? "user_flow_closed" : this.resolveFailureStage(runId),
    };
    this.baselineSnapshots.set(runId, snapshot);
    this.registerBaselineSnapshot(snapshot, scenario?.status === "passed");
    return snapshot;
  }

  getBaseline(runId: string): ScenarioBaselineSnapshot | null {
    return this.baselineSnapshots.get(runId) || this.captureBaseline(runId);
  }

  diffScenarioBaselines(baselineRunId: string, currentRunId: string): { baselineFound: boolean; currentFound: boolean; changed: ScenarioDiffItem[] } {
    const baseline = this.getBaseline(baselineRunId);
    const current = this.getBaseline(currentRunId);
    if (!baseline || !current) {
      return { baselineFound: Boolean(baseline), currentFound: Boolean(current), changed: [] };
    }
    const changed: ScenarioDiffItem[] = [];
    const diffList = (kind: ScenarioDiffItem["kind"], left: string[], right: string[]) => {
      const keys = uniqValues([...left, ...right]);
      for (const key of keys) {
        const inLeft = left.includes(key);
        const inRight = right.includes(key);
        if (inLeft && inRight) continue;
        changed.push({
          kind,
          key,
          status: inLeft && !inRight ? "removed" : "added",
          baselineValue: inLeft ? key : "",
          currentValue: inRight ? key : "",
        });
      }
    };
    diffList("step", baseline.keyStepSequence, current.keyStepSequence);
    diffList("request", baseline.requestSequence, current.requestSequence);
    diffList("state", baseline.stateTransitions, current.stateTransitions);
    diffList("assertion", baseline.assertionResults.map((item) => `${item.id}:${item.status}`), current.assertionResults.map((item) => `${item.id}:${item.status}`));
    diffList("signal", baseline.signalPresence, current.signalPresence);
    return { baselineFound: true, currentFound: true, changed };
  }

  listProjectBaselines(target?: SupportedTarget): ProjectBaselineRegistry {
    const entries = Array.from(this.baselineRegistry.values()).filter((entry) => !target || entry.target === target);
    return {
      entries,
      sources: uniqValues(entries.map((entry) => entry.source)),
    };
  }

  getRegressionDiff(baselineRunId: string, currentRunId: string, scenarioId?: string): RegressionGateResult {
    const diff = this.diffScenarioBaselines(baselineRunId, currentRunId);
    const currentScenario = this.getScenarioReport(currentRunId);
    const resolvedScenarioId = scenarioId || currentScenario?.scenarioId || "default";
    const pageKey = currentScenario?.pageKey;
    const blocking = Boolean(currentScenario?.blocking);
    const relevantChanged = diff.changed.filter((item) => item.status !== "unchanged");
    const blockingDiffs: BlockingScenarioDiff[] = [];
    const nonBlockingDiffs: BlockingScenarioDiff[] = [];
    const bucket: BlockingScenarioDiff = {
      scenarioId: resolvedScenarioId,
      pageKey,
      blocking,
      changed: relevantChanged,
    };
    if (blocking && relevantChanged.length > 0) {
      blockingDiffs.push(bucket);
    } else if (relevantChanged.length > 0) {
      nonBlockingDiffs.push(bucket);
    }
    return {
      baselineRunId,
      currentRunId,
      blockingDiffs,
      nonBlockingDiffs,
      decision: blockingDiffs.length > 0 ? "hold" : nonBlockingDiffs.length > 0 ? "manual_review_required" : "ship",
      baselineRefs: [`run:${baselineRunId}`, ...(resolvedScenarioId ? [`scenario:${resolvedScenarioId}`] : [])],
      failedChecks: relevantChanged.map((item) => `${item.kind}:${item.key}:${item.status}`),
      blockingReasons: blockingDiffs.flatMap((item) => item.changed.map((change) => `${change.kind}:${change.key}:${change.status}`)),
    };
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
    const checks = [hasStepBoundaries, hasNetworkSignals, hasRouteSignals, hasLifecycleSignals || run?.target !== "miniapp", hasRenderSignals || run?.target !== "web"];
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

  async detectTarget(target?: string, projectRoot?: string): Promise<TargetDetectionReport> {
    return this.inspectorFor(projectRoot).detectTarget(target);
  }

  async getProjectResolution(target?: string, projectRoot?: string): Promise<ProjectResolutionReport> {
    return this.inspectorFor(projectRoot).resolveProject(target);
  }

  async getProjectCompatibility(target?: string, projectRoot?: string): Promise<WebIntegrationReport | MiniappProjectIntegrationReport | null> {
    const detected = await this.inspectorFor(projectRoot).detectTarget(target);
    if (detected.supportedTarget === "web") {
      return this.inspectWebProject(projectRoot);
    }
    if (detected.supportedTarget === "miniapp") {
      return this.inspectMiniappProject(projectRoot);
    }
    return null;
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
        reason: "Miniapp projects support verify-first integration checks plus executable runtime closure when a compatible driver is available.",
        recommendedAction: "Run relay miniapp verify, then relay miniapp run for executable closure evidence.",
        supportedTargets: SUPPORTED_TARGETS,
        currentCapabilities: ["miniapp-sdk", "integration-verify", "collection", "integrity", "diagnosis", "scenario", "closure", "release-decision"],
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
      requiredSignals: ["console", "lifecycle", "route_or_network", "step_boundary", "state_signature", "request_attribution"],
      bestPractice: "Prefer wrapper-first runtime relay instrumentation over tool-console observation.",
      support,
    };
  }

  getDriverContract(target: string, driver: string): RuntimeDriverContract {
    const normalizedTarget = (target === "miniapp" ? "miniapp" : "web") as SupportedTarget;
    if (normalizedTarget === "miniapp") {
      const miniappDriver = (
        driver === "devtools-automator" || driver === "external-agent" || driver === "generic-miniapp-driver"
          ? driver
          : "external-agent"
      ) as MiniappDriverType;
      return {
        target: "miniapp",
        driver: miniappDriver,
        positioning: miniappDriver === "devtools-automator" ? "reference_driver" : "external_agent_driver",
        executable: miniappDriver === "devtools-automator",
        requiredOrder: [
          "doctor target",
          "project verify",
          "runs start",
          "bind run and step in miniapp relay",
          "execute declared miniapp actions",
          "validate scenario",
          "query collection and closure",
          "query release decision and handoff on failure",
        ],
        requiredApiCalls: [
          "POST /ai/project/identify",
          "GET /ai/miniapp/project-check",
          "POST /runs/start",
          "POST /runs/:runId/steps/start",
          "POST /ingest",
          "POST /scenarios/validate",
          "GET /ai/run/:runId/collection",
          "GET /ai/run/:runId/closure",
          "GET /ai/run/:runId/release-decision",
          "GET /ai/run/:runId/handoff",
        ],
        requiredSignals: ["console", "lifecycle", "route_or_network", "step_boundary", "state_signature", "request_attribution"],
        requiredActions: ["launch", "enter_page", "tap", "input", "pull_down_refresh", "switch_tab", "navigate_back", "share_entry", "retry"],
        sdkBindingContract: {
          mustBindRun: true,
          mustBindStep: true,
          mustEmitActionBoundary: true,
          preferredAdapters: ["createMiniappRelay"],
        },
        closureContract: {
          mustCheckCollection: true,
          mustCheckScenario: true,
          mustCheckClosure: true,
          mustCheckReleaseDecision: true,
          mustCheckHandoffOnFailure: true,
        },
        stopConditions: [
          "blocking scenario passed and releaseDecision.decision === ship",
          "driver_not_available",
          "collection.status === incomplete",
          "scenario blocking failure",
          "regression detected",
        ],
        forbiddenClaims: [
          "Do not claim miniapp closure from verify-only evidence.",
          "Do not skip action-boundary binding for executed miniapp steps.",
          "Do not treat route/lifecycle observation alone as user-flow closure.",
        ],
      } satisfies MiniappDriverContract;
    }
    const normalizedDriver = (
      driver === "playwright" || driver === "computer-use" || driver === "ide-agent" || driver === "generic-browser-agent"
        ? driver
        : "generic-browser-agent"
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
    } satisfies DriverAgnosticContract;
  }

  getDriverContractCompliance(runId: string, driver?: string): DriverContractComplianceReport | null {
    const run = this.runs.getRun(runId);
    if (!run || (run.target !== "web" && run.target !== "miniapp")) return null;
    const metadataDriver = typeof run.metadata.driver === "string" ? String(run.metadata.driver) : "";
    const contract = this.getDriverContract(run.target, driver || metadataDriver || (run.target === "web" ? "computer-use" : "external-agent"));
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
    if ("mustCheckScenario" in contract.closureContract && contract.closureContract.mustCheckScenario) {
      const scenario = this.getScenarioReport(runId);
      if (!scenario) {
        missingRequirements.push("missing_scenario_validation");
      } else if (scenario.blocking && scenario.status !== "passed") {
        missingRequirements.push("blocking_scenario_not_passed");
      }
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
      ...(run.target === "miniapp" && this.getMiniappSignalReport(runId)?.stateSignatures.length ? ["state_signature"] : []),
      ...(run.target === "miniapp" && this.getMiniappSignalReport(runId)?.attributedRequestCount ? ["request_attribution"] : []),
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
        failureStage: "runtime_events_observed",
        reasonCode: "runtime_not_observed",
        decision: { status: "running", confidence: 0.2, reason: "Run is still in progress.", reasonCode: "runtime_not_observed" },
      };
    }
    if (!baselineRunId) {
      const isCleanPass = summary.errorCount === 0 && summary.incidentCount === 0 && run.status === "passed";
      const hasRuntimeFailure = run.status === "failed" || run.status === "aborted" || summary.errorCount > 0 || summary.incidentCount > 0;
      const scenario = this.getScenarioReport(runId);
      const miniappScenarioResolved = run.target === "miniapp" && isCleanPass && scenario?.blocking === true && scenario.status === "passed";
      return {
        runId,
        baselineRunId: "",
        isResolved: miniappScenarioResolved || isCleanPass,
        hasRegression: false,
        newIncidentCount: 0,
        resolvedIncidentCount: 0,
        regressedIncidentCount: 0,
        confidence: hasRuntimeFailure ? 0.72 : miniappScenarioResolved ? 0.91 : 0.45,
        evidence: [
          "missing_baseline",
          `run_status=${run.status}`,
          `error_count=${summary.errorCount}`,
          `incident_count=${summary.incidentCount}`,
          ...(miniappScenarioResolved ? [`scenario_passed=${scenario?.scenarioId}`] : []),
        ],
        failureStage: hasRuntimeFailure ? "runtime_events_observed" : miniappScenarioResolved ? "user_flow_closed" : "instrumentation_attached",
        reasonCode: hasRuntimeFailure ? "assertion_failed" : miniappScenarioResolved ? "miniapp_blocking_scenario_passed" : "low_confidence",
        decision: hasRuntimeFailure
          ? {
              status: "unresolved",
              confidence: 0.72,
              reason: "No baseline run is available, but the current run still contains runtime failures.",
              reasonCode: "assertion_failed",
            }
          : miniappScenarioResolved
            ? {
                status: "resolved",
                confidence: 0.91,
                reason: "Miniapp blocking scenario passed with clean runtime evidence even without a prior baseline.",
                reasonCode: "miniapp_blocking_scenario_passed",
              }
          : {
              status: "inconclusive",
              confidence: 0.45,
              reason: "No baseline run is available for closure comparison.",
              reasonCode: "low_confidence",
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
      failureStage: isResolved ? "user_flow_closed" : this.resolveFailureStage(runId),
      reasonCode: decision.reasonCode || (hasRegression ? "regression_detected" : "assertion_failed"),
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
    const miniappObservation = run.target === "miniapp" ? this.getMiniappSignalReport(runId) : null;
    const requiredSignals =
      run.target === "miniapp"
        ? ["console", "lifecycle", "route_or_network", "step_boundary", "state_signature", "request_attribution"]
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
      ...(miniappObservation?.stateSignatures.length ? ["state_signature"] : []),
      ...(miniappObservation?.attributedRequestCount ? ["request_attribution"] : []),
    ].filter(Boolean);
    const missingSignals = collection?.signalGaps || [];
    const supportAllowsRuntimeReadiness = targetSupport.status !== "unsupported" && targetSupport.status !== "inapplicable";
    const bestPracticeCompliant =
      supportAllowsRuntimeReadiness &&
      missingSignals.length === 0 &&
      (run.target === "web" ? Boolean(integrity.hasRenderSignals) : Boolean(miniappObservation?.observationReady));
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
      evidenceLayer: this.resolveReadinessLayer(integrity, collection?.status === "complete"),
      requiredSignals,
      availableSignals,
      missingSignals,
      autoloopEligible: run.target === "web" && bestPracticeCompliant,
      blockingReasons: [
        ...(supportAllowsRuntimeReadiness ? [] : [targetSupport.reasonCode]),
        ...missingSignals,
      ],
      recommendedIntegrationMode: run.target === "web" ? "browser-injected" : "wrapper-first",
      bestPracticeCompliant,
      verifiedWhat: availableSignals,
      notVerifiedYet: missingSignals,
      releaseEligible: bestPracticeCompliant && collection?.status === "complete",
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
    const miniappObservation = run.target === "miniapp" ? this.getMiniappSignalReport(runId) : null;
    const miniappExecution = run.target === "miniapp" ? this.getMiniappExecution(runId) : null;
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
    const releaseDecision = this.getRunReleaseDecision(runId);
    const failureFamily = this.classifyFailureFamily(runId);
    return {
      runId,
      target: run.target,
      evidenceLayer: verdict.evidenceLayer || runtimeReadiness?.evidenceLayer,
      failureFamily,
      support,
      triggerDecision,
      projectVerify: {
        mode: projectVerifyMode,
        projectId: project?.projectId || "",
        status: support.status,
        closureEligible: Boolean(runtimeReadiness?.bestPracticeCompliant && collection?.status === "complete" && closure?.decision.status === "resolved"),
        autoloopEligible: Boolean(runtimeReadiness?.autoloopEligible),
        blockingReasons: projectBlockingReasons,
        evidenceLayer: runtimeReadiness?.evidenceLayer || "project_structure",
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
      scenario: this.getScenarioReport(runId),
      miniappObservation,
      miniappExecution,
      targetSupport: null,
      verifiedWhat: runtimeReadiness?.verifiedWhat || [],
      notVerifiedYet: runtimeReadiness?.notVerifiedYet || [],
      releaseEligible: verdict.releaseEligible || false,
      blockingItems: releaseDecision?.blockingItems || [],
      nonBlockingItems: releaseDecision?.nonBlockingItems || [],
      releaseDecision: releaseDecision || undefined,
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
        ? input.runId
          ? "relay miniapp closure --runId <runId>"
          : "relay miniapp verify"
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

  async identifyProject(target?: string, projectRoot?: string): Promise<ProjectProfile | null> {
    const inspector = this.inspectorFor(projectRoot);
    const identified = await inspector.identify(target);
    if (!identified.supportedTarget) return null;
    if (identified.supportedTarget === "web") {
      const report = await this.inspectWebProject(projectRoot);
      const profile = inspector.toProfile({
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
    const report = await this.inspectMiniappProject(projectRoot);
    const profile = inspector.toProfile({
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

  async inspectWebProject(projectRoot?: string): Promise<WebIntegrationReport> {
    return this.inspectorFor(projectRoot).inspectWeb();
  }

  async inspectMiniappProject(projectRoot?: string): Promise<MiniappProjectIntegrationReport> {
    return this.inspectorFor(projectRoot).inspectMiniapp();
  }

  getMiniappSignalReport(runId: string): MiniappSignalReport | null {
    const run = this.runs.getRun(runId);
    if (!run || run.target !== "miniapp") return null;
    const events = this.events.listByRun(runId);
    const scenario = this.getScenarioReport(runId);
    const actionBoundaries = this.getRunActions(runId);
    const attribution = this.getRunRequestAttribution(runId).filter((item) => item.relatedStepId);
    const stateSnapshots = this.getRunStateSnapshots(runId);
    const routeTransitions = events.filter((event) => event.phase === "navigation").length;
    const lifecycleTransitions = events.filter((event) => event.phase === "lifecycle").length;
    const setDataEvents = events.filter((event) => event.message.includes("setData") || event.tags.includes("setData"));
    const requestEvents = events.filter((event) => event.phase === "network" && event.network?.stage !== "start");
    const requestToUiContinuity =
      requestEvents.length === 0
        ? "missing"
        : attribution.length > 0 && attribution.every((item) => item.attributionStatus === "attributed")
          ? "complete"
          : "partial";
    const observedPages = uniqValues(events.map((event) => event.route).filter(Boolean)).slice(0, 20);
    const lifecycleHooks = uniqValues(
      events
        .filter((event) => event.phase === "lifecycle")
        .map((event) => {
          const hook = typeof event.context?.hookName === "string" ? event.context.hookName : "";
          return hook || event.message;
        })
        .filter(Boolean)
    ).slice(0, 20);
    const stateSignatures = uniqValues(
      stateSnapshots
        .map((snapshot) =>
          typeof this.events.listByRun(runId).find((event) => event.sequence === snapshot.sequence)?.context?.stateSignature === "string"
            ? String(this.events.listByRun(runId).find((event) => event.sequence === snapshot.sequence)?.context?.stateSignature)
            : snapshot.fields.filter((field) => !field.startsWith("route:")).join("|")
        )
        .filter(Boolean)
    ).slice(0, 20);
    const attributedRequestCount = attribution.filter((item) => item.attributionStatus === "attributed").length;
    const requestAttributionCoverage = requestEvents.length > 0 ? Math.round((attributedRequestCount / requestEvents.length) * 100) : 0;
    const actionStepCount = this.runs.listSteps(runId).filter((step) => step.endedSequence > 0 || step.startedSequence > 0).length;
    const actionsObserved = uniqValues(
      actionBoundaries.map((boundary) => {
        const step = this.runs.getStep(runId, boundary.stepId);
        return typeof step?.metadata.actionType === "string" ? String(step.metadata.actionType) : "";
      }).filter(Boolean)
    );
    const assertionEvidence: MiniappAssertionEvidence[] =
      scenario?.assertions.map((assertion) => ({
        assertionId: assertion.id,
        status: assertion.status,
        matchedSignals: assertion.matchedSequences.map((sequence) => {
          const event = events.find((candidate) => candidate.sequence === sequence);
          return event ? `${event.phase}:${event.message}` : `sequence:${sequence}`;
        }),
        blocking: Boolean((this.scenarioSpecs.get(scenario.scenarioId)?.assertions || []).find((item) => item.id === assertion.id)?.blocking ?? scenario.blocking),
      })) || [];
    const observationReady =
      actionStepCount > 0 &&
      observedPages.length > 0 &&
      lifecycleTransitions > 0 &&
      stateSignatures.length > 0 &&
      requestEvents.length > 0 &&
      attributedRequestCount > 0;
    return {
      runId,
      setDataCoverage: setDataEvents.length > 0 ? 100 : 0,
      routeTransitions,
      lifecycleContinuity: lifecycleTransitions > 1 ? "complete" : lifecycleTransitions > 0 ? "partial" : "missing",
      requestToUiContinuity,
      observedPages,
      lifecycleHooks,
      stateSignatures,
      actionStepCount,
      actionsObserved,
      requestCount: requestEvents.length,
      attributedRequestCount,
      requestAttributionCoverage,
      assertionEvidence,
      scenarioBlockingStatus: scenario ? (scenario.blocking ? scenario.status === "passed" ? "passed" : "failed" : "missing") : "missing",
      observationReady,
      evidenceLayer: observationReady ? "runtime_events_observed" : routeTransitions > 0 || lifecycleTransitions > 0 ? "instrumentation_attached" : "project_structure",
      warnings: [
        ...(setDataEvents.length === 0 ? ["missing_setData_signal"] : []),
        ...(stateSignatures.length === 0 ? ["missing_state_signature"] : []),
        ...(actionStepCount === 0 ? ["missing_action_steps"] : []),
        ...(requestEvents.length > 0 && attributedRequestCount === 0 ? ["missing_request_attribution"] : []),
        ...(requestToUiContinuity !== "complete" ? ["missing_request_to_ui_continuity"] : []),
      ],
    };
  }

  getRunFailureChain(runId: string): RunFailureChain | null {
    const diagnosis = this.listRunDiagnosis(runId);
    if (!diagnosis) return null;
    const events = this.events.listByRun(runId);
    const linkedNetworkEvents = events.filter((event) => event.phase === "network" && event.sequence <= diagnosis.firstFailureSequence).slice(-3).map((event) => event.sequence);
    const linkedLifecycleEvents = events.filter((event) => event.phase === "lifecycle" && event.sequence <= diagnosis.firstFailureSequence).slice(-3).map((event) => event.sequence);
    const linkedStateTransitions = events
      .filter((event) => event.message.includes("setData") || event.tags.includes("render_complete"))
      .slice(-5)
      .map((event) => `${event.phase}:${event.message}`);
    return {
      runId,
      originStage: this.resolveFailureStage(runId),
      dominantFailureStep: diagnosis.dominantFailureStep?.name || "",
      firstFailureSequence: diagnosis.firstFailureSequence,
      evidence: [
        ...diagnosis.suspectedRootCauses.map((item) => item.message),
        ...diagnosis.missingSignals.map((item) => `missing:${item}`),
      ].slice(0, 10),
      incidentFingerprints: diagnosis.topIncidents.map((item) => item.fingerprint).slice(0, 10),
      rootCauseHints: diagnosis.suspectedRootCauses,
      linkedNetworkEvents,
      linkedLifecycleEvents,
      linkedStateTransitions,
      suspectedLayer:
        diagnosis.suspectedRootCauses.some((item) => item.kind === "network_precedes_ui")
          ? "network"
          : diagnosis.suspectedRootCauses.some((item) => item.kind === "navigation_breakage")
            ? "routing"
            : diagnosis.suspectedRootCauses.some((item) => item.kind === "lifecycle_interrupted")
              ? "data_consumption"
              : diagnosis.missingSignals.length > 0
                ? "integration"
                : "state_machine",
    };
  }

  getRunActions(runId: string): RunActionBoundary[] {
    return this.actionBoundaries.get(runId) || this.captureActionBoundaries(runId);
  }

  getRunStateSnapshots(runId: string): StateSnapshot[] {
    return this.stateSnapshots.get(runId) || this.captureStateSnapshots(runId);
  }

  getRunRequestAttribution(runId: string): RequestAttribution[] {
    return this.requestAttributions.get(runId) || this.captureRequestAttribution(runId);
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
      failureStage: closure.failureStage,
    };
  }

  getExecutableHandoff(runId: string): ExecutableHandoffArtifact | null {
    const handoff = this.getRunHandoff(runId);
    const report = this.getRunReport(runId);
    const chain = this.getRunFailureChain(runId);
    if (!handoff || !report) return null;
    const requests = this.getRunRequestAttribution(runId)
      .map((item) => {
        const event = this.events.listByRun(runId).find((candidate) => candidate.sequence === item.requestSequence);
        return event?.network?.url || event?.message || "";
      })
      .filter(Boolean)
      .slice(0, 8);
    const lifecycleHooks = this.events
      .listByRun(runId)
      .filter((event) => event.phase === "lifecycle")
      .map((event) => event.message)
      .slice(0, 8);
    const relatedPages = uniqValues(
      this.events
        .listByRun(runId)
        .map((event) => event.route)
        .filter(Boolean)
    ).slice(0, 8);
    return {
      project: handoff.project,
      run: handoff.run,
      failureFamily: this.classifyFailureFamily(runId),
      failureStage: handoff.failureStage || report.verdict.evidenceLayer || "runtime_events_observed",
      dominantFailureChain: chain,
      likelyRootLayer: chain?.suspectedLayer || "unknown",
      relatedPages,
      relatedRequests: requests,
      relatedLifecycleHooks: lifecycleHooks,
      whatWasVerified: report.verifiedWhat || [],
      whatWasNotVerified: report.notVerifiedYet || [],
      whatWasTried: handoff.whatWasTried,
      recommendedInvestigationEntry: [
        ...(relatedPages[0] ? [`page:${relatedPages[0]}`] : []),
        ...(requests[0] ? [`request:${requests[0]}`] : []),
        ...(chain?.dominantFailureStep ? [`step:${chain.dominantFailureStep}`] : []),
      ],
      recommendedNextValidation: handoff.recommendedNextActions,
      recommendedFixDirection: this.getRunRepairStrategy(runId)?.reasons || [],
      driverFailureSummary: this.getMiniappExecution(runId)?.driverFailureSummary || [],
      baselineCompareSummary: this.resolveBaselineRunId(runId) ? this.getBaselineCompareSummary(this.resolveBaselineRunId(runId), runId) : null,
      releaseDecision: this.getRunReleaseDecision(runId) || {
        decision: "hold",
        riskLevel: "high",
        blockingItems: [report.verdict.reason],
        nonBlockingItems: [],
        confidence: report.verdict.confidence,
        evidenceLayer: report.verdict.evidenceLayer || "runtime_events_observed",
        why: [report.verdict.nextAction],
      },
    };
  }

  getRunReleaseDecision(runId: string): ReleaseDecisionReport | null {
    const report = this.getRunReportShallow(runId);
    if (!report) return null;
    const run = this.runs.getRun(runId);
    const miniappObservation = run?.target === "miniapp" ? this.getMiniappSignalReport(runId) : null;
    const scenario = this.getScenarioReport(runId);
    const driverCheck = this.getDriverContractCompliance(runId);
    const actions = this.getRunActions(runId);
    const regression = report.closure?.baselineRunId ? this.getRegressionDiff(report.closure.baselineRunId, runId, scenario?.scenarioId) : null;
    const blockingItems: string[] = [];
    const nonBlockingItems: string[] = [];
    const baselineRefs = uniqValues([
      ...(report.closure?.baselineRunId ? [`run:${report.closure.baselineRunId}`] : []),
      ...(scenario?.baselineKey ? [scenario.baselineKey] : []),
    ]);
    const blockingScenarioIds = scenario?.blocking ? [scenario.scenarioId] : [];
    if (report.support.status === "unsupported" || report.support.status === "inapplicable") {
      blockingItems.push(report.support.reasonCode);
    }
    if (report.runtimeReadiness?.evidenceLayer !== "user_flow_closed") {
      nonBlockingItems.push(`evidence_layer:${report.runtimeReadiness?.evidenceLayer || "project_structure"}`);
    }
    if (report.collection?.status === "incomplete") {
      blockingItems.push("collection_incomplete");
    }
    if (driverCheck && !driverCheck.compliant) {
      blockingItems.push(...driverCheck.missingRequirements);
    }
    if (run?.target === "miniapp" && miniappObservation && !miniappObservation.observationReady) {
      blockingItems.push("miniapp_observation_incomplete");
    }
    if (run?.target === "miniapp" && actions.length === 0) {
      blockingItems.push("action_not_executed");
    }
    if (report.closure?.decision.status === "unresolved" || report.closure?.decision.status === "regressed") {
      blockingItems.push(`closure:${report.closure.decision.status}`);
    }
    if (scenario?.blocking && scenario.status !== "passed") {
      blockingItems.push(`scenario:${scenario.scenarioId}:${scenario.status}`);
    } else if (scenario && scenario.status !== "passed") {
      nonBlockingItems.push(`scenario:${scenario.scenarioId}:${scenario.status}`);
    }
    if (report.closure?.hasRegression) {
      blockingItems.push("regression_detected");
    }
    if (regression?.blockingDiffs.length) {
      blockingItems.push(...regression.blockingReasons);
    }
    if (regression?.nonBlockingDiffs.length) {
      nonBlockingItems.push(...regression.nonBlockingDiffs.flatMap((item) => item.changed.map((change) => `${change.kind}:${change.key}:${change.status}`)));
    }
    if (run?.target === "miniapp" && !scenario) {
      nonBlockingItems.push("scenario_not_executed");
    }
    if (report.closure?.decision.status === "resolved" && blockingItems.length === 0 && report.runtimeReadiness?.evidenceLayer === "user_flow_closed") {
      return {
        decision: "ship",
        riskLevel: "low",
        blockingItems: [],
        nonBlockingItems,
        confidence: report.closure.confidence,
        evidenceLayer: "user_flow_closed",
        why: ["resolved_closure", "user_flow_closed", "no_blocking_scenario_failure"],
        baselineRefs,
        blockingScenarioIds,
      };
    }
    if (blockingItems.length > 0) {
      return {
        decision: "hold",
        riskLevel: report.closure?.hasRegression ? "critical" : "high",
        blockingItems,
        nonBlockingItems,
        confidence: report.closure?.confidence || 0.8,
        evidenceLayer: report.verdict.evidenceLayer || report.runtimeReadiness?.evidenceLayer || "project_structure",
        why: blockingItems,
        baselineRefs,
        blockingScenarioIds,
      };
    }
    return {
      decision: "manual_review_required",
      riskLevel: "medium",
      blockingItems: [],
      nonBlockingItems,
      confidence: report.verdict.confidence,
      evidenceLayer: report.verdict.evidenceLayer || "runtime_events_observed",
      why: ["runtime_observed_without_closed_flow"],
      baselineRefs,
      blockingScenarioIds,
    };
  }

  getRunVerificationReport(runId: string): ClosureEvidenceReport | null {
    return this.getRunReport(runId);
  }

  getCiVerificationResult(mode: "readiness" | "scenario-smoke" | "closure" | "report" | "regression", runId?: string): CiVerificationResult {
    const report = runId ? this.getRunReport(runId) : null;
    if (!report) {
      return {
        status: "unsupported",
        failedChecks: ["missing_run_report"],
        blockingReasons: ["missing_run_report"],
        artifacts: [],
        recommendedExitCode: 4,
      };
    }
    if (mode === "readiness") {
      const readiness = report.runtimeReadiness;
      if (!readiness) {
        return {
          status: "unsupported",
          failedChecks: ["missing_runtime_readiness"],
          blockingReasons: ["missing_runtime_readiness"],
          artifacts: [runId || ""],
          recommendedExitCode: 4,
        };
      }
      if (readiness.bestPracticeCompliant && readiness.evidenceLevel === "runtime_verified") {
        return {
          status: "pass",
          failedChecks: [],
          blockingReasons: [],
          artifacts: [runId || ""],
          recommendedExitCode: 0,
        };
      }
      return {
        status: "hold",
        failedChecks: readiness.missingSignals,
        blockingReasons: readiness.blockingReasons,
        artifacts: [runId || ""],
        recommendedExitCode: 3,
      };
    }
    if (mode === "scenario-smoke") {
      const scenario = this.getScenarioReport(runId || "");
      if (!scenario) {
        return {
          status: "manual_review_required",
          failedChecks: ["missing_scenario_report"],
          blockingReasons: [],
          artifacts: [runId || ""],
          recommendedExitCode: 2,
        };
      }
      if (scenario.status === "passed") {
        return {
          status: "pass",
          failedChecks: [],
          blockingReasons: [],
          artifacts: [runId || ""],
          recommendedExitCode: 0,
        };
      }
      if (scenario.blocking) {
        return {
          status: "hold",
          failedChecks: scenario.missingEvidence,
          blockingReasons: scenario.missingEvidence,
          artifacts: [runId || ""],
          recommendedExitCode: 3,
        };
      }
      return {
        status: "manual_review_required",
        failedChecks: scenario.missingEvidence,
        blockingReasons: [],
        artifacts: [runId || ""],
        recommendedExitCode: 2,
      };
    }
    if (mode === "regression") {
      const closure = this.listRunClosure(runId || "");
      if (!closure?.baselineRunId) {
        return {
          status: "unsupported",
          failedChecks: ["missing_baseline_reference"],
          blockingReasons: ["missing_baseline_reference"],
          artifacts: [runId || ""],
          baselineRefs: [],
          recommendedExitCode: 4,
        };
      }
      const regression = this.getRegressionDiff(closure.baselineRunId, runId || "");
      return {
        status: regression.decision === "ship" ? "pass" : regression.decision,
        failedChecks: regression.failedChecks,
        blockingReasons: regression.blockingReasons,
        artifacts: [runId || ""],
        baselineRefs: regression.baselineRefs,
        recommendedExitCode: regression.decision === "ship" ? 0 : regression.decision === "manual_review_required" ? 2 : 3,
      };
    }
    const release = this.getRunReleaseDecision(runId || "") || {
      decision: "hold",
      riskLevel: "high",
      blockingItems: ["missing_release_decision"],
      nonBlockingItems: [],
      confidence: 0.2,
      evidenceLayer: "project_structure" as const,
      why: ["missing_release_decision"],
    };
    if (release.decision === "ship") {
      return { status: "pass", failedChecks: [], blockingReasons: [], artifacts: [runId || ""], baselineRefs: release.baselineRefs || [], recommendedExitCode: 0 };
    }
    if (release.decision === "manual_review_required") {
      return {
        status: "manual_review_required",
        failedChecks: release.nonBlockingItems,
        blockingReasons: release.blockingItems,
        artifacts: [runId || ""],
        baselineRefs: release.baselineRefs || [],
        recommendedExitCode: 2,
      };
    }
    return {
      status: "hold",
      failedChecks: [...release.blockingItems, ...release.nonBlockingItems],
      blockingReasons: release.blockingItems,
      artifacts: [runId || ""],
      baselineRefs: release.baselineRefs || [],
      recommendedExitCode: 3,
    };
  }

  getRunRootCauseMap(runId: string) {
    const diagnosis = this.listRunDiagnosis(runId);
    const failureChain = this.getRunFailureChain(runId);
    if (!diagnosis || !failureChain) return null;
    return {
      runId,
      rootCauseHints: diagnosis.suspectedRootCauses,
      suspectedLayer: failureChain.suspectedLayer,
      linkedNetworkEvents: failureChain.linkedNetworkEvents || [],
      linkedLifecycleEvents: failureChain.linkedLifecycleEvents || [],
      linkedStateTransitions: failureChain.linkedStateTransitions || [],
    };
  }

  getShortHumanSummary(runId: string): ShortHumanSummary | null {
    const report = this.getRunReport(runId);
    if (!report) return null;
    return {
      title: `Run ${runId}`,
      verdict: report.verdict.status,
      message: report.verdict.reason,
      topFindings: [
        ...(report.collection?.signalGaps || []).slice(0, 2),
        ...(report.diagnosis?.suspectedRootCauses.map((item) => item.message) || []).slice(0, 2),
      ].slice(0, 4),
    };
  }

  getFailureOnePager(runId: string): FailureOnePager | null {
    const handoff = this.getRunHandoff(runId);
    const report = this.getRunReport(runId);
    if (!handoff || !report) return null;
    return {
      runId,
      failureStage: handoff.failureStage || report.verdict.evidenceLayer || "runtime_events_observed",
      summary: report.verdict.reason,
      topIncidents: handoff.topIncidents.map((incident) => incident.sampleMessage).slice(0, 5),
      signalGaps: handoff.signalGaps,
      nextActions: handoff.recommendedNextActions.slice(0, 5),
    };
  }

  getPrCommentSummary(runId: string): PRCommentSummary | null {
    const report = this.getRunReport(runId);
    if (!report) return null;
    return {
      verdict: report.verdict.status,
      headline: `Runtime verification ${report.verdict.status}`,
      bullets: [
        `evidence_layer=${report.verdict.evidenceLayer || "project_structure"}`,
        ...(report.collection?.signalGaps || []).slice(0, 2),
        report.verdict.nextAction,
      ].filter(Boolean),
    };
  }

  getIssueSummary(runId: string): IssueSummary | null {
    const failure = this.getFailureOnePager(runId);
    if (!failure) return null;
    return {
      title: `Runtime validation blocked at ${failure.failureStage}`,
      severity: failure.failureStage === "user_flow_closed" ? "low" : failure.failureStage === "runtime_events_observed" ? "medium" : "high",
      body: [failure.summary, ...failure.signalGaps, ...failure.nextActions].slice(0, 8),
    };
  }

  getBaselineCompareSummary(baselineRunId: string, currentRunId: string): BaselineCompareSummary | null {
    const diff = this.diffScenarioBaselines(baselineRunId, currentRunId);
    const closure = this.listRunClosure(currentRunId);
    const regression = this.getRegressionDiff(baselineRunId, currentRunId);
    if (!diff.baselineFound || !diff.currentFound || !closure) return null;
    return {
      baselineRunId,
      currentRunId,
      verdict: closure.decision.status === "resolved" ? "resolved" : closure.decision.status === "regressed" ? "unresolved" : "inconclusive",
      changedRequests: diff.changed.filter((item) => item.kind === "request").map((item) => item.key),
      changedStates: diff.changed.filter((item) => item.kind === "state").map((item) => item.key),
      changedAssertions: diff.changed.filter((item) => item.kind === "assertion").map((item) => item.key),
      blockingChanges: regression.blockingDiffs.flatMap((item) => item.changed.map((change) => `${change.kind}:${change.key}`)),
      nonBlockingChanges: regression.nonBlockingDiffs.flatMap((item) => item.changed.map((change) => `${change.kind}:${change.key}`)),
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
    const scenario = this.getScenarioReport(runId);
    const baseline = this.getBaseline(runId);
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
      scenario,
      miniappObservation: run.target === "miniapp" ? this.getMiniappSignalReport(runId) : null,
      baseline,
      reportSummaries: {
        shortHuman: this.getShortHumanSummary(runId) || {
          title: `Run ${runId}`,
          verdict: report?.verdict.status || "inconclusive",
          message: report?.verdict.reason || "No report available.",
          topFindings: [],
        },
        failureOnePager: this.getFailureOnePager(runId) || {
          runId,
          failureStage: closure.failureStage,
          summary: closure.decision.reason,
          topIncidents: this.listRunIncidents(runId, 3).map((incident) => incident.sampleMessage),
          signalGaps: collection?.signalGaps || [],
          nextActions: [report?.verdict.nextAction || "Check handoff."],
        },
        prComment: this.getPrCommentSummary(runId) || {
          verdict: report?.verdict.status || "inconclusive",
          headline: `Runtime verification ${report?.verdict.status || "inconclusive"}`,
          bullets: [report?.verdict.reason || "No report available."],
        },
        issueSummary: this.getIssueSummary(runId) || {
          title: `Runtime validation for ${runId}`,
          severity: "medium",
          body: [report?.verdict.reason || "No report available."],
        },
        baselineCompare: baselineRunId ? this.getBaselineCompareSummary(baselineRunId, runId) : null,
      },
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
      return {
        status: "resolved",
        confidence: 0.92,
        reason: "The run passed without remaining incidents or errors compared to baseline.",
        reasonCode: "assertion_failed",
      };
    }
    if (hasRegression) {
      return {
        status: "regressed",
        confidence: 0.88,
        reason: "The current run introduced or intensified failures relative to baseline.",
        reasonCode: "regression_detected",
      };
    }
    if (run.status === "failed" || summary.errorCount > 0 || summary.incidentCount > 0 || diff.some((item) => item.status === "new")) {
      return {
        status: "unresolved",
        confidence: 0.84,
        reason: "The current run still contains unresolved incidents or errors.",
        reasonCode: "assertion_failed",
      };
    }
    return {
      status: "inconclusive",
      confidence: 0.55,
      reason: "The run ended cleanly, but evidence is insufficient to claim closure.",
      reasonCode: "low_confidence",
    };
  }

  private buildClosureVerdict(
    runId: string,
    support: TargetCapabilityReport,
    runtimeReadiness: ReturnType<RelayEngine["getRunReadiness"]>,
    driverCheck: DriverContractComplianceReport | null,
    collection: BugCollectionReport | null,
    closure: RunClosure | null
  ): ClosureVerdict {
    const run = this.runs.getRun(runId);
    const miniappObservation = run?.target === "miniapp" ? this.getMiniappSignalReport(runId) : null;
    const scenario = this.getScenarioReport(runId);
    if (support.status === "unsupported" || support.status === "inapplicable") {
      return {
        status: "unsupported",
        reason: support.reasonCode,
        confidence: 0.99,
        nextAction: support.recommendedAction,
        evidenceLayer: "project_structure",
        releaseEligible: false,
      };
    }
    if (support.target === "miniapp" && (!runtimeReadiness || runtimeReadiness.evidenceLevel !== "runtime_verified" || collection?.status !== "complete")) {
      return {
        status: "integration_required",
        reason: "miniapp_verify_required",
        confidence: 0.92,
        nextAction: "Run miniapp verify and collect runtime signals before claiming closure.",
        evidenceLayer: runtimeReadiness?.evidenceLayer || "project_structure",
        releaseEligible: false,
      };
    }
    if (support.target === "miniapp" && !miniappObservation?.observationReady) {
      return {
        status: "integration_required",
        reason: "miniapp_observation_incomplete",
        confidence: 0.9,
        nextAction: "Bind run/step and collect route -> lifecycle -> request -> setData continuity for a real miniapp flow.",
        evidenceLayer: miniappObservation?.evidenceLayer || runtimeReadiness?.evidenceLayer || "instrumentation_attached",
        releaseEligible: false,
      };
    }
    if (support.target === "miniapp" && !scenario) {
      return {
        status: "inconclusive",
        reason: "miniapp_scenario_missing",
        confidence: 0.65,
        nextAction: "Execute or validate a blocking miniapp scenario before claiming closure.",
        evidenceLayer: runtimeReadiness?.evidenceLayer || "runtime_events_observed",
        releaseEligible: false,
      };
    }
    if (support.target === "miniapp" && scenario?.blocking && scenario.status !== "passed") {
      return {
        status: "unresolved",
        reason: "miniapp_scenario_blocked",
        confidence: 0.86,
        nextAction: "Fix the blocking miniapp scenario failure or produce a handoff.",
        evidenceLayer: "runtime_events_observed",
        releaseEligible: false,
      };
    }
    if (!runtimeReadiness || runtimeReadiness.evidenceLevel !== "runtime_verified") {
      return {
        status: "integration_required",
        reason: "runtime_unverified",
        confidence: 0.9,
        nextAction: "Run a real instrumented flow and query run-scoped readiness.",
        evidenceLayer: runtimeReadiness?.evidenceLayer || "instrumentation_attached",
        releaseEligible: false,
      };
    }
    if (driverCheck && !driverCheck.compliant) {
      return {
        status: "integration_required",
        reason: "driver_contract_failed",
        confidence: 0.95,
        nextAction: "Fix run/step binding and required signal capture before closure claims.",
        evidenceLayer: runtimeReadiness.evidenceLayer,
        releaseEligible: false,
      };
    }
    if (!collection || collection.status !== "complete") {
      return {
        status: "integration_required",
        reason: "insufficient_collection",
        confidence: 0.94,
        nextAction: "Fix missing signals before closure claims.",
        evidenceLayer: runtimeReadiness.evidenceLayer,
        releaseEligible: false,
      };
    }
    if (!closure) {
      return {
        status: "inconclusive",
        reason: "missing_closure",
        confidence: 0.4,
        nextAction: "Query closure after the run finishes.",
        evidenceLayer: runtimeReadiness.evidenceLayer,
        releaseEligible: false,
      };
    }
    if (closure.decision.status === "resolved") {
      return {
        status: "resolved",
        reason: "closure_resolved",
        confidence: closure.confidence,
        nextAction: "Stop and report closure evidence.",
        evidenceLayer: "user_flow_closed",
        releaseEligible: true,
      };
    }
    if (closure.decision.status === "running") {
      return {
        status: "inconclusive",
        reason: "run_in_progress",
        confidence: closure.confidence,
        nextAction: "Wait for run completion, then re-check closure.",
        evidenceLayer: closure.failureStage,
        releaseEligible: false,
      };
    }
    if (closure.decision.status === "regressed" || closure.hasRegression) {
      return {
        status: "unresolved",
        reason: "regression",
        confidence: closure.confidence,
        nextAction: "Review regressions and produce handoff if not immediately fixable.",
        evidenceLayer: closure.failureStage,
        releaseEligible: false,
      };
    }
    return {
      status: closure.decision.status === "unresolved" ? "unresolved" : "inconclusive",
      reason: closure.decision.reason,
      confidence: closure.confidence,
      nextAction: closure.decision.status === "unresolved" ? "Use repair brief and handoff to continue from evidence." : "Do not claim done; gather stronger runtime evidence.",
      evidenceLayer: closure.failureStage,
      releaseEligible: false,
    };
  }

  private resolveReadinessLayer(integrity: IntegrityReport, collectionComplete: boolean): "project_structure" | "instrumentation_attached" | "runtime_events_observed" | "user_flow_closed" {
    const scenario = this.scenarioReports.get(integrity.runId);
    if (scenario?.status === "passed") {
      return "user_flow_closed";
    }
    if (collectionComplete && integrity.hasStepBoundaries) {
      return "runtime_events_observed";
    }
    if (integrity.hasNetworkSignals || integrity.hasRouteSignals || integrity.hasLifecycleSignals || integrity.hasRenderSignals) {
      return "instrumentation_attached";
    }
    return "project_structure";
  }

  private resolveFailureStage(runId: string): "project_structure" | "instrumentation_attached" | "runtime_events_observed" | "user_flow_closed" {
    const scenario = this.scenarioReports.get(runId);
    if (scenario?.status === "passed") {
      return "user_flow_closed";
    }
    const integrity = this.listRunIntegrity(runId);
    const collection = this.listRunCollection(runId);
    if (collection?.status === "complete" && integrity.hasStepBoundaries) {
      return "runtime_events_observed";
    }
    if (integrity.hasNetworkSignals || integrity.hasRouteSignals || integrity.hasLifecycleSignals || integrity.hasRenderSignals) {
      return "instrumentation_attached";
    }
    return "project_structure";
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
    const projectRoot = typeof run.metadata.projectRoot === "string" ? String(run.metadata.projectRoot) : undefined;
    const profile = await this.identifyProject(run.target, projectRoot);
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
      scenarioResults: this.getScenarioReport(runId) ? [`${this.getScenarioReport(runId)?.scenarioId}:${this.getScenarioReport(runId)?.status}`] : [],
      blockingScenarioPasses:
        this.getScenarioReport(runId)?.blocking && this.getScenarioReport(runId)?.status === "passed" ? [this.getScenarioReport(runId)?.scenarioId || ""] : [],
      blockingScenarioFailures:
        this.getScenarioReport(runId)?.blocking && this.getScenarioReport(runId)?.status !== "passed" ? [this.getScenarioReport(runId)?.scenarioId || ""] : [],
      driverFailurePatterns: this.getMiniappExecution(runId)?.driverFailureSummary || [],
      failureStage: closure?.failureStage,
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
    if (run.target === "miniapp") {
      if (!integrity.hasLifecycleSignals) {
        gaps.push("missing_lifecycle_signals");
      }
      if (!integrity.hasRouteSignals && !integrity.hasNetworkSignals) {
        gaps.push("missing_route_or_network_signals");
      }
      const observation = this.getMiniappSignalReport(runId);
      if (!observation?.stateSignatures.length) {
        gaps.push("missing_state_signature");
      }
      if (observation && observation.requestCount > 0 && observation.attributedRequestCount === 0) {
        gaps.push("missing_request_attribution");
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

  private inspectorFor(projectRoot?: string): ProjectInspector {
    const root = projectRoot && String(projectRoot).trim() ? path.resolve(String(projectRoot)) : this.workspaceRoot;
    return new ProjectInspector(root);
  }

  private createCheckpoint(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  recordMiniappExecution(runId: string, execution: MiniappExecutionCoordinatorResult): MiniappExecutionCoordinatorResult {
    this.miniappExecutions.set(runId, execution);
    return execution;
  }

  getMiniappExecution(runId: string): MiniappExecutionCoordinatorResult | null {
    const stored = this.miniappExecutions.get(runId);
    if (stored) return stored;
    const run = this.runs.getRun(runId);
    if (!run || run.target !== "miniapp") return null;
    const actions = this.getRunActions(runId);
    if (actions.length === 0) return null;
    const items = actions.map((action) => ({
      actionId: action.actionId || `${runId}:${action.stepId}`,
      actionType: (action.actionType === "navigate" ? "enter_page" : "tap") as MiniappExecutionCoordinatorResult["actionResults"][number]["type"],
      pagePath: action.pagePath,
      stage: "execute_actions" as const,
      completionStatus: action.completionStatus || "executed",
      success: action.completionStatus !== "failed" && action.completionStatus !== "timeout",
      reason: action.completionStatus || "runtime_observed",
      retries: Number(action.retryCount || 0),
      timeoutMs: Number(action.timeoutMs || 0),
      emittedEventCount: 0,
    }));
    const derived: MiniappExecutionCoordinatorResult = {
      runId,
      driver: (run.metadata.driver || "external-agent") as MiniappDriverType,
      stage: "finalize_closure",
      status: "executed",
      stopReason: items.some((item) => !item.success) ? "bridge_action_incomplete" : "completed",
      driverResolution: {
        target: "miniapp",
        driver: (run.metadata.driver || "external-agent") as MiniappDriverType,
        executable: true,
        stage: "resolve_driver",
        status: "resolved",
        reason: "derived_from_run_actions",
        checks: ["derived_from_run_actions"],
        projectRoot: String(run.metadata.projectRoot || this.workspaceRoot),
      },
      executionLedger: {
        runId,
        items,
        completedActions: items.filter((item) => item.completionStatus === "executed").length,
        failedActions: items.filter((item) => item.completionStatus === "failed" || item.completionStatus === "partial").length,
        timeoutActions: items.filter((item) => item.completionStatus === "timeout").length,
        bridgeActions: items.filter((item) => item.completionStatus === "bridge_required").length,
      },
      actionResults: items.map((item) => ({
        actionId: item.actionId,
        type: item.actionType,
        pagePath: item.pagePath,
        success: item.success,
        reason: item.reason,
        completionStatus: item.completionStatus,
        retries: item.retries,
        timeoutMs: item.timeoutMs,
      })),
      reason: "derived_from_run_actions",
      retrySummary: {
        attemptedActions: items.length,
        retriedActions: items.filter((item) => item.retries > 0).length,
        maxRetriesObserved: Math.max(0, ...items.map((item) => item.retries)),
      },
      driverFailureSummary: items.filter((item) => !item.success).map((item) => `${item.actionId}:${item.reason}`),
    };
    return derived;
  }

  private registerBaselineSnapshot(snapshot: ScenarioBaselineSnapshot, success: boolean, source: ScenarioTemplateSource = "builtin", filePath?: string): void {
    const scenario = this.scenarioSpecs.get(snapshot.scenarioId);
    const key = snapshot.baselineKey || `${snapshot.scenarioId}:${snapshot.pageKey || "default"}`;
    const current = this.baselineRegistry.get(key) || {
      baselineKey: key,
      source,
      scenarioId: snapshot.scenarioId,
      pageKey: snapshot.pageKey,
      target: scenario?.target,
      latestSuccess: null,
      latestFailure: null,
      failureSummary: [],
      filePath,
    };
    const next: ProjectBaselineRegistryEntry = {
      ...current,
      source,
      target: scenario?.target || current.target,
      pageKey: snapshot.pageKey || current.pageKey,
      filePath: filePath || current.filePath,
      latestSuccess: success ? snapshot : current.latestSuccess,
      latestFailure: success ? current.latestFailure : snapshot,
      failureSummary: success ? current.failureSummary || [] : [`${snapshot.scenarioId}:${snapshot.evidenceLayer}`],
    };
    this.baselineRegistry.set(key, next);
  }

  private async loadProjectScenarios(): Promise<void> {
    const root = process.env.DEV_LOG_RELAY_WORKSPACE_ROOT ? path.resolve(process.env.DEV_LOG_RELAY_WORKSPACE_ROOT) : this.workspaceRoot;
    const scenarioDir = path.join(root, "tooling", "scenarios");
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      const files = await readdir(scenarioDir);
      for (const file of files.filter((item) => item.endsWith(".json"))) {
        const raw = await readFile(path.join(scenarioDir, file), "utf8");
        const spec = JSON.parse(raw) as ScenarioSpec;
        if (spec && spec.id && (spec.target === "web" || spec.target === "miniapp")) {
          this.scenarioSpecs.set(spec.id, spec);
          this.scenarioSources.set(spec.id, {
            scenario: spec,
            source: "project_local",
            filePath: path.join(scenarioDir, file),
            conflictWith: TEMPLATE_SPECS.find((item) => item.id === spec.id)?.id || "",
          });
        }
      }
    } catch {
      // optional project scenarios
    }
  }

  private async loadProjectBaselines(): Promise<void> {
    const root = process.env.DEV_LOG_RELAY_WORKSPACE_ROOT ? path.resolve(process.env.DEV_LOG_RELAY_WORKSPACE_ROOT) : this.workspaceRoot;
    const baselineDir = path.join(root, "tooling", "baselines");
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      const files = await readdir(baselineDir);
      for (const file of files.filter((item) => item.endsWith(".json"))) {
        const absolute = path.join(baselineDir, file);
        const raw = await readFile(absolute, "utf8");
        const snapshot = JSON.parse(raw) as ScenarioBaselineSnapshot;
        if (snapshot && snapshot.scenarioId) {
          this.registerBaselineSnapshot(snapshot, snapshot.evidenceLayer === "user_flow_closed", "project_local", absolute);
        }
      }
    } catch {
      // optional project baselines
    }
  }

  private captureDerivedRunFacts(runId: string): void {
    this.captureActionBoundaries(runId);
    this.captureStateSnapshots(runId);
    this.captureRequestAttribution(runId);
  }

  private captureActionBoundaries(runId: string): RunActionBoundary[] {
    const boundaries = this.runs.listSteps(runId).map((step) => ({
      id: `${runId}:${step.id}`,
      runId,
      stepId: step.id,
      actionType: step.kind,
      startedSequence: step.startedSequence,
      endedSequence: step.endedSequence,
      route: step.route,
      pagePath:
        typeof step.metadata.pagePath === "string"
          ? String(step.metadata.pagePath)
          : typeof step.metadata.route === "string"
            ? String(step.metadata.route)
            : step.route,
      actionId: typeof step.metadata.actionId === "string" ? String(step.metadata.actionId) : "",
      triggerSource:
        (step.metadata.triggerSource === "reference_driver" ||
        step.metadata.triggerSource === "external_agent" ||
        step.metadata.triggerSource === "runtime_observed"
          ? step.metadata.triggerSource
          : "runtime_observed") as "reference_driver" | "external_agent" | "runtime_observed",
      completionStatus:
        (step.metadata.completionStatus === "executed" ||
        step.metadata.completionStatus === "partial" ||
        step.metadata.completionStatus === "failed" ||
        step.metadata.completionStatus === "timeout" ||
        step.metadata.completionStatus === "bridge_required"
          ? step.metadata.completionStatus
          : undefined) as RunActionBoundary["completionStatus"],
      timeoutMs: Number(step.metadata.timeoutMs || 0) || undefined,
      retryCount: Number(step.metadata.retryCount || 0) || undefined,
    }));
    this.actionBoundaries.set(runId, boundaries);
    return boundaries;
  }

  private captureStateSnapshots(runId: string): StateSnapshot[] {
    const snapshots = this.events
      .listByRun(runId)
      .filter((event) => {
        const contextKeys = Object.keys(event.context || {});
        const hasExplicitStateSignal =
          event.message.includes("setData") ||
          event.tags.includes("setData") ||
          event.tags.includes("state") ||
          event.tags.includes("state_update") ||
          event.tags.includes("model_update") ||
          contextKeys.some((key) => /(^|_)(state|model|viewmodel|data)(_|$)/i.test(key));
        const hasLifecycleStateSignal = event.phase === "lifecycle" && hasExplicitStateSignal;
        return hasExplicitStateSignal || hasLifecycleStateSignal;
      })
      .map((event) => ({
        runId,
        stepId: event.stepId,
        sequence: event.sequence,
        scope:
          event.message.includes("setData") || event.tags.includes("setData")
            ? "miniapp_setData"
            : event.phase === "lifecycle"
              ? "lifecycle"
              : "state",
        signature: `${event.phase}:${event.message}`,
        fields: uniqValues([
          ...event.tags,
          ...Object.keys(event.context || {}),
          ...(event.route ? [`route:${event.route}`] : []),
        ]),
        pagePath: event.route || (typeof event.context?.destinationRoute === "string" ? String(event.context.destinationRoute) : undefined),
        componentPath: typeof event.component === "string" ? event.component : undefined,
        dataKeys: Array.isArray(event.context?.keys)
          ? (event.context?.keys as unknown[]).map((item) => String(item))
          : Object.keys((event.context?.fields as Record<string, unknown>) || {}),
        derivedUiState: inferMiniappUiState(event),
      } satisfies StateSnapshot));
    this.stateSnapshots.set(runId, snapshots);
    return snapshots;
  }

  private captureRequestAttribution(runId: string): RequestAttribution[] {
    const events = this.events.listByRun(runId).sort((left, right) => left.sequence - right.sequence);
    const run = this.runs.getRun(runId);
    const states = this.captureStateSnapshots(runId);
    const attribution = events
      .filter((event) => event.phase === "network" && event.network?.stage !== "start")
      .map((event) => {
        const render = events.find((candidate) => candidate.sequence > event.sequence && candidate.sequence <= event.sequence + 8 && candidate.phase === "render");
        const lifecycle = events.find((candidate) => candidate.sequence > event.sequence && candidate.sequence <= event.sequence + 8 && candidate.phase === "lifecycle");
        const state = states.find((candidate) => candidate.sequence > event.sequence && candidate.sequence <= event.sequence + 8);
        const isMiniapp = run?.target === "miniapp";
        return {
          runId,
          requestSequence: event.sequence,
          relatedStepId: event.stepId,
          route: event.route,
          downstreamRenderSequence: render?.sequence,
          downstreamLifecycleSequence: lifecycle?.sequence,
          downstreamStateSequence: state?.sequence,
          attributionStatus:
            !event.stepId
              ? "missing_step"
              : isMiniapp
                ? state
                  ? "attributed"
                  : lifecycle
                    ? "missing_state"
                    : "missing_lifecycle"
                : render && state
                  ? "attributed"
                  : render
                    ? "missing_state"
                    : "missing_render",
        } satisfies RequestAttribution;
      });
    this.requestAttributions.set(runId, attribution);
    return attribution;
  }

  private classifyFailureFamily(runId: string): VerificationFailureFamily {
    const support = this.runs.getRun(runId) ? this.getTargetSupport(this.runs.getRun(runId)!.target) : null;
    const closure = this.listRunClosure(runId);
    const collection = this.listRunCollection(runId);
    const readiness = this.getRunReadiness(runId);
    if (!support || support.status === "unsupported") return "unsupported_target";
    if (support.status === "inapplicable") return "inapplicable_runtime";
    if (!readiness || readiness.evidenceLayer === "project_structure" || collection?.status === "incomplete") return "integration_failure";
    if (readiness.evidenceLayer === "instrumentation_attached") return "observation_failure";
    if (closure?.hasRegression || closure?.decision.status === "regressed") return "regression_failure";
    return "business_failure";
  }

  private getRunReportShallow(runId: string): {
    support: TargetCapabilityReport;
    runtimeReadiness: RuntimeRelayReadinessReport | null;
    collection: BugCollectionReport | null;
    closure: RunClosure | null;
    verdict: ClosureVerdict;
  } | null {
    const run = this.runs.getRun(runId);
    if (!run) return null;
    const support = this.getTargetSupport(run.target);
    const runtimeReadiness = this.getRunReadiness(runId);
    const collection = this.listRunCollection(runId);
    const closure = this.listRunClosure(runId);
    const verdict = this.buildClosureVerdict(runId, support, runtimeReadiness, this.getDriverContractCompliance(runId), collection, closure);
    return { support, runtimeReadiness, collection, closure, verdict };
  }
}
