import fs from "node:fs";
import type {
  DriverResolutionReport,
  ExecutionLedger,
  ExecutionLedgerItem,
  MiniappDriverType,
  MiniappExecutionCoordinatorResult,
  MiniappExecutionStopReason,
  MiniappProjectIntegrationReport,
  ScenarioSpec,
} from "../types.js";
import { executeMiniappReferenceDriver } from "../drivers/miniapp-reference-driver.js";

interface MiniappExecutionCoordinatorInput {
  relay: string;
  runId: string;
  driver: MiniappDriverType;
  scenario: ScenarioSpec;
  projectRoot: string;
  driverModule?: string;
  projectCheck?: MiniappProjectIntegrationReport | null;
}

function toLedgerItem(runId: string, timeoutMs: number, actionResult: MiniappExecutionCoordinatorResult["actionResults"][number]): ExecutionLedgerItem {
  const completionStatus =
    actionResult.completionStatus ||
    (actionResult.success ? "executed" : actionResult.reason.includes("timeout") ? "timeout" : actionResult.reason.includes("bridge") ? "bridge_required" : "failed");
  return {
    actionId: actionResult.actionId,
    actionType: actionResult.type,
    pagePath: actionResult.pagePath,
    stage: "execute_actions",
    completionStatus,
    success: actionResult.success,
    reason: actionResult.reason,
    retries: Number(actionResult.retries || 0),
    timeoutMs: Number(actionResult.timeoutMs || timeoutMs || 0),
    emittedEventCount: actionResult.emittedEvents?.length || 0,
  };
}

export class MiniappExecutionCoordinator {
  async execute(input: MiniappExecutionCoordinatorInput): Promise<MiniappExecutionCoordinatorResult> {
    const timeoutMs = Number(input.scenario.retryPolicy?.timeoutMs || 5000);
    const checks = [
      fs.existsSync(input.projectRoot) ? "project_root_exists" : "project_root_missing",
      input.projectCheck?.blockingIssues?.length ? "project_check_blocking_issues" : "project_check_ready",
      input.driverModule ? "driver_module_configured" : "driver_module_not_configured",
      input.scenario.actions?.length ? "scenario_actions_declared" : "scenario_actions_inferred",
    ];
    const driverResolution: DriverResolutionReport = {
      target: "miniapp",
      driver: input.driver,
      executable: Boolean(fs.existsSync(input.projectRoot) && !input.projectCheck?.blockingIssues?.length),
      stage: "resolve_driver",
      status: fs.existsSync(input.projectRoot) ? "resolved" : "project_not_ready",
      reason: fs.existsSync(input.projectRoot) ? "project_root_resolved" : "project_root_missing",
      checks,
      projectRoot: input.projectRoot,
    };

    if (!fs.existsSync(input.projectRoot)) {
      return {
        runId: input.runId,
        driver: input.driver,
        stage: "resolve_project",
        status: "driver_not_available",
        stopReason: "driver_resolution_failed",
        driverResolution: {
          ...driverResolution,
          executable: false,
          status: "project_not_ready",
          reason: "project_root_missing",
        },
        executionLedger: {
          runId: input.runId,
          items: [],
          completedActions: 0,
          failedActions: 0,
          timeoutActions: 0,
          bridgeActions: 0,
        },
        actionResults: [],
        reason: "project_root_missing",
        retrySummary: {
          attemptedActions: 0,
          retriedActions: 0,
          maxRetriesObserved: 0,
        },
        driverFailureSummary: ["project_root_missing"],
      };
    }

    const execution = await executeMiniappReferenceDriver({
      driver: input.driver,
      scenario: input.scenario,
      relay: input.relay,
      runId: input.runId,
      projectRoot: input.projectRoot,
      driverModule: input.driverModule,
    });

    const actionResults = execution.actionResults.map((item) => ({
      ...item,
      completionStatus:
        item.completionStatus ||
        (execution.status === "bridge_required"
          ? "bridge_required"
          : item.success
            ? "executed"
            : item.reason.includes("timeout")
              ? "timeout"
              : "failed"),
      retries: Number(item.retries || 0),
      timeoutMs: Number(item.timeoutMs || timeoutMs),
    }));
    const ledgerItems = actionResults.map((item) => toLedgerItem(input.runId, timeoutMs, item));
    const executionLedger: ExecutionLedger = {
      runId: input.runId,
      items: ledgerItems,
      completedActions: ledgerItems.filter((item) => item.completionStatus === "executed").length,
      failedActions: ledgerItems.filter((item) => item.completionStatus === "failed" || item.completionStatus === "partial").length,
      timeoutActions: ledgerItems.filter((item) => item.completionStatus === "timeout").length,
      bridgeActions: ledgerItems.filter((item) => item.completionStatus === "bridge_required").length,
    };
    const driverFailureSummary = ledgerItems.filter((item) => !item.success).map((item) => `${item.actionId}:${item.reason}`);

    let stopReason: MiniappExecutionStopReason | undefined = "completed";
    if (execution.status === "bridge_required") {
      stopReason = "bridge_payload_invalid";
    } else if (execution.status === "driver_not_available") {
      stopReason = "driver_bootstrap_failed";
    } else if (ledgerItems.some((item) => item.completionStatus === "timeout")) {
      stopReason = "driver_execution_interrupted";
    } else if (ledgerItems.some((item) => !item.success)) {
      stopReason = "bridge_action_incomplete";
    }

    return {
      runId: input.runId,
      driver: input.driver,
      stage: execution.status === "bridge_required" ? "execute_actions" : "finalize_closure",
      status: execution.status,
      stopReason,
      driverResolution: {
        ...driverResolution,
        executable: execution.status === "executed",
        status: execution.status === "bridge_required" ? "bridge_required" : execution.status === "driver_not_available" ? "driver_not_available" : "resolved",
        reason: execution.reason,
      },
      executionLedger,
      actionResults,
      reason: execution.reason,
      retrySummary: {
        attemptedActions: ledgerItems.length,
        retriedActions: ledgerItems.filter((item) => item.retries > 0).length,
        maxRetriesObserved: Math.max(0, ...ledgerItems.map((item) => item.retries)),
      },
      driverFailureSummary,
    };
  }
}
