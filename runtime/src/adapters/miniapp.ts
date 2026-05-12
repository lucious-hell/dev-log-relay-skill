/* eslint-disable @typescript-eslint/no-explicit-any */
import type { BindingState, EventPhase, LogLevel, MiniappIntegrationReport, RelayNetworkMeta, RelaySelfCheck } from "../types.js";

declare const wx: any;

type MiniappEntityConfig = Record<string, any>;

export interface MiniappRelayOptions {
  endpoint: string;
  source?: "miniapp";
  sessionIdProvider?: () => string;
  routeProvider?: () => string;
}

export interface MiniappRelayExtra {
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

export interface MiniappPatchResult {
  enabled: boolean;
  appliedCapabilities: string[];
  warnings: string[];
}

function uniqTags(tags: string[]): string[] {
  return Array.from(new Set(tags.filter(Boolean)));
}

function getMiniappPageStack(): Array<{ route: string }> {
  const getter = (globalThis as Record<string, any>).getCurrentPages;
  if (typeof getter !== "function") return [];
  try {
    const pages = getter();
    return Array.isArray(pages)
      ? pages
          .map((page) => ({ route: typeof page?.route === "string" ? page.route : "" }))
          .filter((page) => page.route)
      : [];
  } catch {
    return [];
  }
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

function wrapHook(config: MiniappEntityConfig, hookName: string, onCall: (...args: unknown[]) => void, onError: (error: unknown) => void) {
  const original = config[hookName];
  config[hookName] = function wrappedHook(...args: unknown[]) {
    onCall(...args);
    const self = this as Record<string, any>;
    const originalSetData = typeof self?.setData === "function" ? self.setData.bind(self) : null;
    if (originalSetData) {
      self.setData = (payload: Record<string, unknown>, callback?: () => void) => {
        onCall({ __relaySetData: true, keys: Object.keys(payload || {}) });
        return originalSetData(payload, callback);
      };
    }
    try {
      if (typeof original === "function") {
        return original.apply(this, args);
      }
      return undefined;
    } catch (error) {
      onError(error);
      throw error;
    } finally {
      if (originalSetData) {
        self.setData = originalSetData;
      }
    }
  };
}

export function createMiniappRelay(options: MiniappRelayOptions) {
  const source = options.source || "miniapp";
  const rawRequest = typeof wx !== "undefined" && typeof wx.request === "function" ? wx.request.bind(wx) : null;
  let boundRunId = "";
  let boundStepId = "";
  let cleanupFns: Array<() => void> = [];
  let autoCaptureActive = false;
  let runtimePatchCleanup: (() => void) | null = null;
  let lastPatchResult: MiniappPatchResult = { enabled: false, appliedCapabilities: [], warnings: [] };
  let wrapperUsed = false;
  let requestCounter = 0;
  const observedSignals = {
    route: 0,
    lifecycle: 0,
    network: 0,
  };

  function buildIntegrationReport(): MiniappIntegrationReport {
    const warnings = [...lastPatchResult.warnings];
    if (!wrapperUsed) warnings.push("wrapper_not_used");
    if (observedSignals.route === 0) warnings.push("missing_route_signals");
    if (observedSignals.lifecycle === 0) warnings.push("missing_lifecycle_signals");
    if (observedSignals.network === 0) warnings.push("missing_network_signals");
    const lifecycleReady = observedSignals.lifecycle > 0;
    const routeReady = observedSignals.route > 0;
    const networkReady = observedSignals.network > 0;
    const consoleReady = true;
    const blockingReasons = [
      ...(!wrapperUsed ? ["wrapper_not_used"] : []),
      ...(!lifecycleReady ? ["missing_lifecycle_signals"] : []),
      ...(!routeReady && !networkReady ? ["missing_route_or_network_signals"] : []),
    ];
    return {
      wrapperCoverage: wrapperUsed ? 100 : 0,
      patchCoverage: Math.min(100, lastPatchResult.appliedCapabilities.length * 20),
      routeCoverage: routeReady ? 100 : 0,
      lifecycleCoverage: lifecycleReady ? 100 : 0,
      networkCoverage: networkReady ? 100 : 0,
      integrationMode: wrapperUsed ? (lastPatchResult.enabled ? "patch-enhanced" : "wrapper-first") : "manual-fallback",
      consoleReady,
      lifecycleReady,
      routeReady,
      networkReady,
      autoloopEligible: false,
      blockingReasons,
      warnings,
    };
  }

  function send(level: LogLevel, message: string, extra: MiniappRelayExtra = {}) {
    if (!rawRequest) {
      return;
    }
    if (extra.phase === "navigation") observedSignals.route += 1;
    if (extra.phase === "lifecycle") observedSignals.lifecycle += 1;
    if (extra.phase === "network") observedSignals.network += 1;
    const pageStack = getMiniappPageStack();
    rawRequest({
      url: options.endpoint,
      method: "POST",
      data: {
        source,
        level,
        message,
        route: extra.route || (options.routeProvider ? options.routeProvider() : "") || pageStack.at(-1)?.route || "",
        sessionId: extra.sessionId || (options.sessionIdProvider ? options.sessionIdProvider() : ""),
        runId: extra.runId || boundRunId,
        stepId: extra.stepId || boundStepId,
        context: {
          pageStackDepth: pageStack.length,
          pageStackRoutes: pageStack.map((page) => page.route),
          ...(extra.context || {}),
        },
        ...extra,
      },
      fail() {},
    });
  }

  function wrapConsole() {
    const consoleHost = console as Record<string, any>;
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    const restore: Array<() => void> = [];
    for (const level of levels) {
      const original = typeof consoleHost[level] === "function" ? consoleHost[level].bind(consoleHost) : undefined;
      consoleHost[level] = (...args: unknown[]) => {
        send(level, stringifyArgs(args), { phase: "log", context: { args } });
        if (original) {
          original(...args);
        }
      };
      restore.push(() => {
        if (original) {
          consoleHost[level] = original;
        }
      });
    }
    return () => {
      for (const undo of restore) {
        undo();
      }
    };
  }

  function wrapRequest() {
    if (typeof wx === "undefined" || typeof wx.request !== "function" || !rawRequest) {
      return () => {};
    }
    const original = wx.request.bind(wx);
    wx.request = (requestOptions: Record<string, any>) => {
      const start = Date.now();
      const requestId = `miniapp-req-${++requestCounter}`;
      const url = String(requestOptions?.url || "");
      const method = String(requestOptions?.method || "GET");
      send("info", `wx.request ${method} ${url}`, {
        phase: "network",
        requestId,
        network: { url, method, stage: "start" },
      });
      const success = requestOptions.success;
      const fail = requestOptions.fail;
      return original({
        ...requestOptions,
        success(response: any) {
          send(response?.statusCode && response.statusCode >= 400 ? "warn" : "info", `wx.request ${method} ${url} -> ${response?.statusCode || 200}`, {
            phase: "network",
            requestId,
            network: {
              url,
              method,
              statusCode: typeof response?.statusCode === "number" ? response.statusCode : undefined,
              ok: !response?.statusCode || response.statusCode < 400,
              durationMs: Date.now() - start,
              stage: response?.statusCode && response.statusCode >= 400 ? "fail" : "success",
            },
          });
          if (typeof success === "function") {
            success(response);
          }
        },
        fail(error: any) {
          send("error", `wx.request ${method} ${url} failed`, {
            phase: "network",
            requestId,
            errorKind: "network_error",
            stack: error?.errMsg || "",
            network: {
              url,
              method,
              ok: false,
              durationMs: Date.now() - start,
              stage: "fail",
            },
          });
          if (typeof fail === "function") {
            fail(error);
          }
        },
      });
    };
    return () => {
      wx.request = original;
    };
  }

  function wrapRouting() {
    if (typeof wx === "undefined") {
      return () => {};
    }
    const names = ["navigateTo", "redirectTo", "switchTab", "reLaunch", "navigateBack"];
    const originalEntries: Array<{ name: string; fn: any }> = [];
    for (const name of names) {
      if (typeof wx[name] !== "function") {
        continue;
      }
      const original = wx[name].bind(wx);
      originalEntries.push({ name, fn: original });
      wx[name] = (payload: Record<string, any>) => {
        send("info", `${name} ${String(payload?.url || "")}`.trim(), {
          phase: "navigation",
          tags: ["route_transition"],
          context: {
            payload,
            destinationRoute: String(payload?.url || ""),
          },
        });
        return original(payload);
      };
    }
    return () => {
      for (const entry of originalEntries) {
        wx[entry.name] = entry.fn;
      }
    };
  }

  function startAutoCapture() {
    if (cleanupFns.length > 0) {
      return;
    }
    cleanupFns = [wrapConsole(), wrapRequest(), wrapRouting()];
    autoCaptureActive = true;
  }

  function stopAutoCapture() {
    for (const cleanup of cleanupFns.reverse()) {
      cleanup();
    }
    cleanupFns = [];
    autoCaptureActive = false;
  }

  function lifecycleHooksFor(kind: "app" | "page" | "component"): string[] {
    if (kind === "app") {
      return ["onLaunch", "onShow", "onHide", "onError"];
    }
    if (kind === "page") {
      return ["onLoad", "onShow", "onReady", "onHide", "onUnload"];
    }
    return ["attached", "ready", "detached"];
  }

  function wrapEntity(kind: "app" | "page" | "component", name: string, config: MiniappEntityConfig): MiniappEntityConfig {
    const next = { ...config };
    for (const hookName of lifecycleHooksFor(kind)) {
      wrapHook(
        next,
        hookName,
        (...args) => {
          const relaySetData = args.find(
            (item) => item && typeof item === "object" && "__relaySetData" in (item as Record<string, unknown>)
          ) as { keys?: string[] } | undefined;
          if (relaySetData) {
            send("info", `${name}.setData`, {
              phase: "lifecycle",
              component: name,
              tags: ["setData", "state_update", "state_signature"],
              context: {
                kind,
                hookName,
                keys: relaySetData.keys || [],
                stateSignature: (relaySetData.keys || []).slice().sort().join("|"),
              },
            });
            return;
          }
          send("info", `${name}.${hookName}`, {
            phase: "lifecycle",
            component: name,
            tags: ["lifecycle_hook"],
            context: { kind, hookName, args },
          });
        },
        (error) => {
          send("error", `${name}.${hookName} failed`, {
            phase: "lifecycle",
            component: name,
            errorKind: "lifecycle_error",
            stack: error instanceof Error ? error.stack || error.message : String(error || ""),
          });
        }
      );
    }
    return next;
  }

  function wrapApp(appConfig: MiniappEntityConfig) {
    wrapperUsed = true;
    return wrapEntity("app", "App", appConfig);
  }

  function wrapPage(pageName: string, pageConfig: MiniappEntityConfig) {
    wrapperUsed = true;
    return wrapEntity("page", pageName, pageConfig);
  }

  function wrapComponent(componentName: string, componentConfig: MiniappEntityConfig) {
    wrapperUsed = true;
    const next = wrapEntity("component", componentName, componentConfig);
    if (next.methods && typeof next.methods === "object") {
      next.methods = { ...next.methods };
      for (const [methodName, fn] of Object.entries(next.methods)) {
        if (typeof fn !== "function") {
          continue;
        }
        next.methods[methodName] = function wrappedComponentMethod(...args: unknown[]) {
          send("info", `${componentName}.${methodName}`, {
            phase: "lifecycle",
            component: componentName,
            context: { methodName, args },
          });
          try {
            return (fn as Function).apply(this, args);
          } catch (error) {
            send("error", `${componentName}.${methodName} failed`, {
              phase: "lifecycle",
              component: componentName,
              errorKind: "component_method_error",
              stack: error instanceof Error ? error.stack || error.message : String(error || ""),
            });
            throw error;
          }
        };
      }
    }
    return next;
  }

  function enableMiniappRuntimePatch(): MiniappPatchResult {
    if (runtimePatchCleanup) {
      return lastPatchResult;
    }
    const appliedCapabilities: string[] = [];
    const warnings: string[] = [];
    const restoreFns: Array<() => void> = [];

    try {
      const requestCleanup = wrapRequest();
      restoreFns.push(requestCleanup);
      appliedCapabilities.push("wx-request");
    } catch {
      warnings.push("patch_request_failed");
    }

    try {
      const routeCleanup = wrapRouting();
      restoreFns.push(routeCleanup);
      appliedCapabilities.push("wx-route");
    } catch {
      warnings.push("patch_route_failed");
    }

    const globalHost = globalThis as Record<string, any>;
    const registries: Array<{ name: string; componentName: string; wrapper: (name: string, config: MiniappEntityConfig) => MiniappEntityConfig }> = [
      { name: "App", componentName: "App", wrapper: (_name, config) => wrapApp(config) },
      { name: "Page", componentName: "Page", wrapper: (name, config) => wrapPage(name, config) },
      { name: "Component", componentName: "Component", wrapper: (name, config) => wrapComponent(name, config) },
    ];

    for (const registry of registries) {
      const original = globalHost[registry.name];
      if (typeof original !== "function") {
        warnings.push(`missing_${registry.name.toLowerCase()}_registry`);
        continue;
      }
      globalHost[registry.name] = (config: MiniappEntityConfig) => {
        const wrapped = registry.wrapper(registry.componentName, config);
        return original(wrapped);
      };
      restoreFns.push(() => {
        globalHost[registry.name] = original;
      });
      appliedCapabilities.push(`registry-${registry.name.toLowerCase()}`);
    }

    runtimePatchCleanup = () => {
      for (const cleanup of restoreFns.reverse()) {
        cleanup();
      }
      runtimePatchCleanup = null;
    };
    lastPatchResult = {
      enabled: appliedCapabilities.length > 0,
      appliedCapabilities,
      warnings,
    };
    return lastPatchResult;
  }

  function disableMiniappRuntimePatch() {
    if (runtimePatchCleanup) {
      runtimePatchCleanup();
    }
    runtimePatchCleanup = null;
    lastPatchResult = { enabled: false, appliedCapabilities: [], warnings: [] };
  }

  return {
    send,
    startAutoCapture,
    stopAutoCapture,
    wrapApp,
    wrapPage,
    wrapComponent,
    enableMiniappRuntimePatch,
    disableMiniappRuntimePatch,
    getBindingState(): BindingState {
      return {
        runId: boundRunId,
        stepId: boundStepId,
        autoCaptureActive,
      };
    },
    selfCheck(): RelaySelfCheck {
      const warnings = [...lastPatchResult.warnings];
      if (!boundRunId) warnings.push("run_not_bound");
      if (!boundStepId) warnings.push("step_not_bound");
      if (!autoCaptureActive) warnings.push("auto_capture_inactive");
      return {
        transportAvailable: Boolean(rawRequest),
        autoCaptureActive,
        runBound: Boolean(boundRunId),
        stepBound: Boolean(boundStepId),
        capturedCapabilities: [
          "console",
          "wx-request",
          "wx-route",
          "state-snapshot",
          "wrap-app",
          "wrap-page",
          "wrap-component",
          ...lastPatchResult.appliedCapabilities,
        ],
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
    capturePageLifecycle(pageName: string, hookName: string, extra: MiniappRelayExtra = {}) {
      send("info", `${pageName}.${hookName}`, {
        ...extra,
        phase: "lifecycle",
        component: pageName,
        tags: uniqTags(["lifecycle_hook", ...(extra.tags || [])]),
        context: {
          hookName,
          ...(extra.context || {}),
        },
      });
    },
    captureStateSnapshot(pageName: string, fields: Record<string, unknown>, extra: MiniappRelayExtra = {}) {
      const keys = Object.keys(fields || {});
      send("info", `${pageName}.state`, {
        ...extra,
        phase: "lifecycle",
        component: pageName,
        tags: uniqTags(["state_snapshot", "state_update", "state_signature", ...(extra.tags || [])]),
        context: {
          keys,
          stateSignature: keys.slice().sort().join("|"),
          fields,
          ...(extra.context || {}),
        },
      });
    },
    captureRouteSnapshot(route: string, extra: MiniappRelayExtra = {}) {
      send("info", `route ${route}`, {
        ...extra,
        route,
        phase: "navigation",
        tags: uniqTags(["route_transition", ...(extra.tags || [])]),
        context: {
          observedRoute: route,
          ...(extra.context || {}),
        },
      });
    },
    validateMiniappIntegration(): MiniappIntegrationReport {
      return buildIntegrationReport();
    },
    collectMiniappBaselineSignals(): MiniappIntegrationReport {
      return buildIntegrationReport();
    },
  };
}
