import { randomUUID } from "node:crypto";
import { buildFingerprint } from "./fingerprint.js";
import type { EventPhase, RelayLogEvent, RelayLogInput, RelayNetworkMeta } from "../types.js";

function sanitizeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function sanitizeNetwork(value: unknown): RelayNetworkMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as RelayNetworkMeta;
  const network: RelayNetworkMeta = {
    url: typeof input.url === "string" ? input.url.slice(0, 1000) : undefined,
    method: typeof input.method === "string" ? input.method.slice(0, 20) : undefined,
    statusCode: typeof input.statusCode === "number" ? input.statusCode : undefined,
    ok: typeof input.ok === "boolean" ? input.ok : undefined,
    durationMs: typeof input.durationMs === "number" ? input.durationMs : undefined,
    stage: input.stage === "start" || input.stage === "success" || input.stage === "fail" ? input.stage : undefined,
  };
  return Object.values(network).some((item) => item !== undefined) ? network : undefined;
}

function asIso(value: string | undefined): string {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function priorityByLevel(level: RelayLogEvent["level"], phase: EventPhase): number {
  if (level === "error") {
    return 100;
  }
  if (level === "warn") {
    return 70;
  }
  if (phase === "network" || phase === "navigation" || phase === "lifecycle" || phase === "resource" || phase === "render" || phase === "guard") {
    return 60;
  }
  if (level === "info") {
    return 40;
  }
  return 20;
}

function normalizePhase(input: RelayLogInput): EventPhase {
  if (
    input.phase === "log" ||
    input.phase === "navigation" ||
    input.phase === "network" ||
    input.phase === "lifecycle" ||
    input.phase === "resource" ||
    input.phase === "render" ||
    input.phase === "guard" ||
    input.phase === "system"
  ) {
    return input.phase;
  }
  if (input.network) {
    return "network";
  }
  return "log";
}

function normalizeErrorKind(input: RelayLogInput): string {
  if (input.errorKind) {
    return String(input.errorKind).slice(0, 100);
  }
  if (input.level === "error") {
    return "runtime_error";
  }
  if (input.level === "warn") {
    return "warning";
  }
  return "";
}

export function normalizeInput(input: RelayLogInput, sequence: number, lateEvent: boolean): RelayLogEvent {
  const phase = normalizePhase(input);
  const timestamp = asIso(input.timestamp);
  const event: RelayLogEvent = {
    id: randomUUID(),
    sequence,
    timestamp,
    receivedAt: new Date().toISOString(),
    source: input.source,
    level: input.level,
    message: String(input.message || "").slice(0, 5000),
    route: String(input.route || "").slice(0, 500),
    sessionId: String(input.sessionId || "").slice(0, 200),
    traceId: String(input.traceId || "").slice(0, 200),
    requestId: String(input.requestId || "").slice(0, 200),
    stack: String(input.stack || "").slice(0, 12000),
    context: sanitizeObject(input.context),
    tags: Array.isArray(input.tags) ? input.tags.map((item) => String(item).slice(0, 50)).slice(0, 20) : [],
    priority: priorityByLevel(input.level, phase),
    fingerprint: "",
    runId: String(input.runId || "").slice(0, 200),
    stepId: String(input.stepId || "").slice(0, 200),
    phase,
    errorKind: normalizeErrorKind(input),
    component: String(input.component || "").slice(0, 200),
    network: sanitizeNetwork(input.network),
    lateEvent,
  };
  event.fingerprint = buildFingerprint(event);
  return event;
}
