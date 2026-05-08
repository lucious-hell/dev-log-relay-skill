import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CheckpointInput, OrchestrationSession, OrchestrationStartInput, RunCheckpoint, StepKind, TestTarget } from "../types.js";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function recommendedSteps(target: TestTarget): Array<{ name: string; kind: StepKind }> {
  const base: Array<{ name: string; kind: StepKind }> = [
    { name: "boot", kind: "setup" },
    { name: "navigate", kind: "navigate" },
    { name: "exercise", kind: "action" },
    { name: "assert", kind: "assert" },
  ];
  if (target === "miniapp") {
    return [{ name: "app-launch", kind: "setup" }, ...base];
  }
  return base;
}

export class OrchestrationStore {
  private readonly sessions = new Map<string, OrchestrationSession>();
  private readonly checkpoints = new Map<string, RunCheckpoint[]>();

  constructor(private readonly artifactDir: string) {}

  start(runId: string, input: OrchestrationStartInput, target: TestTarget): OrchestrationSession {
    const artifactPathHint = path.join(this.artifactDir, `${runId}.json`);
    const session: OrchestrationSession = {
      runId,
      scenario: String(input.scenario || "default").slice(0, 200),
      baselineRunId: String(input.baselineRunId || "").slice(0, 200),
      recommendedSteps: recommendedSteps(target),
      artifactPathHint,
      createdAt: nowIso(),
    };
    this.sessions.set(runId, session);
    this.checkpoints.set(runId, []);
    return session;
  }

  addCheckpoint(runId: string, input: CheckpointInput): RunCheckpoint {
    const checkpoint: RunCheckpoint = {
      id: randomUUID(),
      runId,
      stepId: String(input.stepId || "").slice(0, 200),
      name: String(input.name || "checkpoint").slice(0, 200),
      createdAt: nowIso(),
      metadata: asObject(input.metadata),
    };
    const existing = this.checkpoints.get(runId) || [];
    existing.push(checkpoint);
    this.checkpoints.set(runId, existing);
    return checkpoint;
  }

  getSession(runId: string): OrchestrationSession | null {
    return this.sessions.get(runId) || null;
  }

  listCheckpoints(runId: string): RunCheckpoint[] {
    return [...(this.checkpoints.get(runId) || [])];
  }
}
