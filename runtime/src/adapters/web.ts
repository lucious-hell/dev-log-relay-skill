import type { BindingState, EventPhase, LogLevel, RelayNetworkMeta, RelaySelfCheck } from "../types.js";

type AnyFn = (...args: any[]) => any;

export interface WebRelayOptions {
  endpoint: string;
  source?: "admin-web";
  fetchImpl?: typeof fetch;
  sessionIdProvider?: () => string;
  routeProvider?: () => string;
}

export interface WebRelayExtra {
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

function stringifyArgs(args: unknown[]): string {
  return args
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join(" ");
}

export function createWebRelay(options: WebRelayOptions) {
  const source = options.source || "admin-web";
  const host = globalThis as any;
  const fetcher = options.fetchImpl || host.fetch;
  let boundRunId = "";
  let boundStepId = "";
  let cleanupFns: Array<() => void> = [];
  let autoCaptureActive = false;
  const capturedCapabilities = ["console", "window-error", "unhandledrejection", "fetch", "xhr", "history-route", "resource-error", "render-guard"];

  async function send(level: LogLevel, message: string, extra: WebRelayExtra = {}) {
    if (typeof fetcher !== "function") {
      return;
    }
    await fetcher(options.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source,
        level,
        message,
        route: extra.route || (options.routeProvider ? options.routeProvider() : ""),
        sessionId: extra.sessionId || (options.sessionIdProvider ? options.sessionIdProvider() : ""),
        runId: extra.runId || boundRunId,
        stepId: extra.stepId || boundStepId,
        ...extra,
      }),
    }).catch(() => {});
  }

  function wrapConsole(): () => void {
    const originalConsole = host.console || {};
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    const restore: Array<() => void> = [];
    for (const level of levels) {
      const original = typeof originalConsole[level] === "function" ? originalConsole[level].bind(originalConsole) : undefined;
      const patched = (...args: unknown[]) => {
        void send(level, stringifyArgs(args), {
          phase: "log",
          context: { args },
        });
        if (original) {
          original(...args);
        }
      };
      originalConsole[level] = patched;
      restore.push(() => {
        if (original) {
          originalConsole[level] = original;
        }
      });
    }
    return () => {
      for (const undo of restore) {
        undo();
      }
    };
  }

  function wrapErrors(): () => void {
    const originalOnError = host.onerror;
    const originalUnhandled = host.onunhandledrejection;
    host.onerror = function onError(message: unknown, _source?: unknown, _lineno?: unknown, _colno?: unknown, error?: unknown) {
      void send("error", String(message || "window error"), {
        phase: "log",
        errorKind: "window_error",
        stack: error instanceof Error ? error.stack || error.message : String(error || ""),
      });
      if (typeof originalOnError === "function") {
        return originalOnError.apply(this, arguments as any);
      }
      return false;
    };
    host.onunhandledrejection = function onUnhandledRejection(event: any) {
      const reason = event && "reason" in event ? event.reason : "";
      void send("error", String(reason instanceof Error ? reason.message : reason || "unhandled rejection"), {
        phase: "log",
        errorKind: "unhandled_rejection",
        stack: reason instanceof Error ? reason.stack || "" : "",
      });
      if (typeof originalUnhandled === "function") {
        return originalUnhandled.apply(this, arguments as any);
      }
      return false;
    };
    return () => {
      host.onerror = originalOnError;
      host.onunhandledrejection = originalUnhandled;
    };
  }

  function wrapFetch(): () => void {
    if (typeof fetcher !== "function") {
      return () => {};
    }
    const originalFetch = fetcher.bind(host);
    const patchedFetch = async (input: unknown, init?: Record<string, unknown>) => {
      const url = typeof input === "string" ? input : String((input as { url?: string })?.url || "");
      const method = typeof init?.method === "string" ? init.method : "GET";
      const start = Date.now();
      void send("info", `fetch ${method} ${url}`, {
        phase: "network",
        network: {
          url,
          method,
          stage: "start",
        },
      });
      try {
        const response = await originalFetch(input as any, init as any);
        void send(response && response.ok ? "info" : "warn", `fetch ${method} ${url} -> ${response.status}`, {
          phase: "network",
          network: {
            url,
            method,
            statusCode: response.status,
            ok: response.ok,
            durationMs: Date.now() - start,
            stage: response.ok ? "success" : "fail",
          },
        });
        return response;
      } catch (error) {
        void send("error", `fetch ${method} ${url} failed`, {
          phase: "network",
          errorKind: "network_error",
          stack: error instanceof Error ? error.stack || error.message : String(error || ""),
          network: {
            url,
            method,
            ok: false,
            durationMs: Date.now() - start,
            stage: "fail",
          },
        });
        throw error;
      }
    };
    host.fetch = patchedFetch;
    return () => {
      host.fetch = originalFetch;
    };
  }

  function wrapHistory(): () => void {
    if (!host.history) {
      return () => {};
    }
    const history = host.history as { pushState?: AnyFn; replaceState?: AnyFn };
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const originalPopState = typeof host.onpopstate === "function" ? host.onpopstate : null;

    function currentRoute() {
      return options.routeProvider ? options.routeProvider() : String(host.location?.pathname || "");
    }

    if (typeof originalPush === "function") {
      history.pushState = function pushState(...args: unknown[]) {
        const result = originalPush.apply(this, args as any);
        void send("info", `route push ${currentRoute()}`, { phase: "navigation" });
        return result;
      };
    }
    if (typeof originalReplace === "function") {
      history.replaceState = function replaceState(...args: unknown[]) {
        const result = originalReplace.apply(this, args as any);
        void send("info", `route replace ${currentRoute()}`, { phase: "navigation" });
        return result;
      };
    }
    host.onpopstate = function onPopState(event: unknown) {
      void send("info", `route pop ${currentRoute()}`, { phase: "navigation", context: { event } });
      if (originalPopState) {
        return originalPopState.apply(this, arguments as any);
      }
      return undefined;
    };

    return () => {
      if (typeof originalPush === "function") {
        history.pushState = originalPush;
      }
      if (typeof originalReplace === "function") {
        history.replaceState = originalReplace;
      }
      host.onpopstate = originalPopState;
    };
  }

  function wrapXHR(): () => void {
    const OriginalXHR = host.XMLHttpRequest;
    if (typeof OriginalXHR !== "function") {
      return () => {};
    }
    host.XMLHttpRequest = function RelayXHR(this: any) {
      const xhr = new OriginalXHR();
      let method = "GET";
      let url = "";
      const startedAt = Date.now();
      const originalOpen = xhr.open;
      xhr.open = function patchedOpen(nextMethod: string, nextUrl: string, ...rest: unknown[]) {
        method = String(nextMethod || "GET");
        url = String(nextUrl || "");
        return originalOpen.call(this, nextMethod, nextUrl, ...(rest as []));
      };
      xhr.addEventListener("loadstart", () => {
        void send("info", `xhr ${method} ${url}`, { phase: "network", network: { url, method, stage: "start" } });
      });
      xhr.addEventListener("loadend", () => {
        void send(xhr.status >= 400 ? "warn" : "info", `xhr ${method} ${url} -> ${xhr.status}`, {
          phase: "network",
          network: { url, method, statusCode: xhr.status, ok: xhr.status < 400, durationMs: Date.now() - startedAt, stage: xhr.status >= 400 ? "fail" : "success" },
        });
      });
      xhr.addEventListener("error", () => {
        void send("error", `xhr ${method} ${url} failed`, {
          phase: "network",
          errorKind: "network_error",
          network: { url, method, ok: false, durationMs: Date.now() - startedAt, stage: "fail" },
        });
      });
      return xhr;
    };
    return () => {
      host.XMLHttpRequest = OriginalXHR;
    };
  }

  function wrapResourceFailures(): () => void {
    if (typeof host.addEventListener !== "function") {
      return () => {};
    }
    const listener = (event: Event) => {
      const target = event.target as { tagName?: string; src?: string; href?: string } | null;
      const assetUrl = target?.src || target?.href || "";
      void send("warn", `resource failed ${String(target?.tagName || "asset").toLowerCase()} ${assetUrl}`.trim(), {
        phase: "resource",
        errorKind: "resource_error",
        context: {
          tagName: target?.tagName || "",
          assetUrl,
        },
      });
    };
    host.addEventListener("error", listener, true);
    return () => {
      host.removeEventListener?.("error", listener, true);
    };
  }

  function wrapRenderGuards(): () => void {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    timers.push(
      setTimeout(() => {
        const body = host.document?.body;
        const root = host.document?.querySelector?.("#app, #root, [data-app-root]");
        const textLength = String(body?.innerText || "").trim().length;
        if (!root && textLength === 0) {
          void send("error", "possible blank screen detected", {
            phase: "guard",
            errorKind: "blank_screen",
            tags: ["blank_screen"],
          });
          return;
        }
        void send("info", "render completed", {
          phase: "render",
          tags: ["render_complete"],
          context: { hasRoot: Boolean(root), textLength },
        });
      }, 0)
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }

  function startAutoCapture() {
    if (cleanupFns.length > 0) {
      return;
    }
    cleanupFns = [wrapConsole(), wrapErrors(), wrapFetch(), wrapXHR(), wrapHistory(), wrapResourceFailures(), wrapRenderGuards()];
    autoCaptureActive = true;
  }

  function stopAutoCapture() {
    for (const cleanup of cleanupFns.reverse()) {
      cleanup();
    }
    cleanupFns = [];
    autoCaptureActive = false;
  }

  return {
    send,
    startAutoCapture,
    stopAutoCapture,
    getBindingState(): BindingState {
      return {
        runId: boundRunId,
        stepId: boundStepId,
        autoCaptureActive,
      };
    },
    selfCheck(): RelaySelfCheck {
      const warnings: string[] = [];
      if (!boundRunId) warnings.push("run_not_bound");
      if (!boundStepId) warnings.push("step_not_bound");
      if (!autoCaptureActive) warnings.push("auto_capture_inactive");
      if (typeof fetcher !== "function") warnings.push("transport_unavailable");
      return {
        transportAvailable: typeof fetcher === "function",
        autoCaptureActive,
        runBound: Boolean(boundRunId),
        stepBound: Boolean(boundStepId),
        capturedCapabilities,
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
