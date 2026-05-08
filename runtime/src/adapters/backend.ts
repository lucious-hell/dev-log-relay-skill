import type { BindingState, EventPhase, LogLevel, RelayNetworkMeta, RelaySelfCheck } from "../types.js";

export interface BackendRelayOptions {
  endpoint: string;
  source?: "backend";
  fetchImpl?: typeof fetch;
}

export interface BackendRelayExtra {
  route?: string;
  sessionId?: string;
  traceId?: string;
  requestId?: string;
  stack?: string;
  context?: Record<string, unknown>;
  tags?: string[];
  phase?: EventPhase;
  errorKind?: string;
  component?: string;
  network?: RelayNetworkMeta;
  runId?: string;
  stepId?: string;
}

export function createBackendRelay(options: BackendRelayOptions) {
  const source = options.source || "backend";
  const fetcher = options.fetchImpl || fetch;
  let boundRunId = "";
  let boundStepId = "";

  async function send(level: LogLevel, message: string, extra: BackendRelayExtra = {}) {
    await fetcher(options.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source,
        level,
        message,
        runId: extra.runId || boundRunId,
        stepId: extra.stepId || boundStepId,
        ...extra,
      }),
    }).catch(() => {});
  }

  return {
    send,
    getBindingState(): BindingState {
      return {
        runId: boundRunId,
        stepId: boundStepId,
        autoCaptureActive: false,
      };
    },
    selfCheck(): RelaySelfCheck {
      const warnings: string[] = [];
      if (!boundRunId) warnings.push("run_not_bound");
      if (!boundStepId) warnings.push("step_not_bound");
      return {
        transportAvailable: typeof fetcher === "function",
        autoCaptureActive: false,
        runBound: Boolean(boundRunId),
        stepBound: Boolean(boundStepId),
        capturedCapabilities: ["manual-send"],
        warnings,
      };
    },
    bindRun(runId: string) {
      boundRunId = String(runId || "");
    },
    bindStep(stepId: string) {
      boundStepId = String(stepId || "");
    },
    clearBinding() {
      boundRunId = "";
      boundStepId = "";
    },
  };
}
