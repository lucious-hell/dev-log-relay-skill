import { randomUUID } from "node:crypto";
import type {
  EndRunInput,
  EndStepInput,
  RunStatus,
  StartRunInput,
  StartStepInput,
  StepStatus,
  TestRun,
  TestStep,
  TestTarget,
} from "../types.js";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class RunStore {
  private readonly runs = new Map<string, TestRun>();
  private readonly steps = new Map<string, TestStep>();
  private readonly runSteps = new Map<string, string[]>();
  private readonly orderedRunIds: string[] = [];

  startRun(input: StartRunInput): TestRun {
    const run: TestRun = {
      id: randomUUID(),
      label: String(input.label || "AI self-test").slice(0, 200),
      target: this.normalizeTarget(input.target),
      status: "running",
      startedAt: nowIso(),
      endedAt: "",
      metadata: asObject(input.metadata),
    };
    this.runs.set(run.id, run);
    this.runSteps.set(run.id, []);
    this.orderedRunIds.push(run.id);
    return run;
  }

  endRun(runId: string, input: EndRunInput): TestRun | null {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") {
      return null;
    }
    run.status = this.normalizeRunStatus(input.status);
    run.endedAt = nowIso();
    run.metadata = { ...run.metadata, ...asObject(input.metadata) };
    const stepIds = this.runSteps.get(runId) || [];
    for (const stepId of stepIds) {
      const step = this.steps.get(stepId);
      if (step && step.status === "running") {
        step.status = run.status === "passed" ? "passed" : "aborted";
        step.endedAt = run.endedAt;
      }
    }
    return run;
  }

  startStep(runId: string, input: StartStepInput, sequence: number): TestStep | null {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") {
      return null;
    }
    const step: TestStep = {
      id: randomUUID(),
      runId,
      name: String(input.name || "unnamed step").slice(0, 200),
      kind: this.normalizeStepKind(input.kind),
      status: "running",
      startedAt: nowIso(),
      endedAt: "",
      startedSequence: sequence,
      endedSequence: 0,
      route: String(input.route || "").slice(0, 500),
      metadata: asObject(input.metadata),
    };
    this.steps.set(step.id, step);
    const stepIds = this.runSteps.get(runId);
    if (stepIds) {
      stepIds.push(step.id);
    } else {
      this.runSteps.set(runId, [step.id]);
    }
    return step;
  }

  endStep(runId: string, stepId: string, input: EndStepInput, sequence: number): TestStep | null {
    const step = this.steps.get(stepId);
    const run = this.runs.get(runId);
    if (!step || step.runId !== runId || !run || run.status !== "running" || step.status !== "running") {
      return null;
    }
    step.status = this.normalizeStepStatus(input.status);
    step.endedAt = nowIso();
    step.endedSequence = sequence;
    step.metadata = { ...step.metadata, ...asObject(input.metadata) };
    return step;
  }

  getRun(runId: string): TestRun | null {
    return this.runs.get(runId) || null;
  }

  getStep(runId: string, stepId: string): TestStep | null {
    const step = this.steps.get(stepId);
    return step && step.runId === runId ? step : null;
  }

  listSteps(runId: string): TestStep[] {
    const stepIds = this.runSteps.get(runId) || [];
    return stepIds.map((stepId) => this.steps.get(stepId)).filter((step): step is TestStep => Boolean(step));
  }

  listRuns(filters: { limit: number; status?: RunStatus; target?: TestTarget }): TestRun[] {
    const runs = this.orderedRunIds
      .map((runId) => this.runs.get(runId))
      .filter((run): run is TestRun => Boolean(run))
      .reverse()
      .filter((run) => {
        if (filters.status && run.status !== filters.status) {
          return false;
        }
        if (filters.target && run.target !== filters.target) {
          return false;
        }
        return true;
      });
    return runs.slice(0, Math.max(0, filters.limit));
  }

  activeRunsCount(): number {
    return Array.from(this.runs.values()).filter((run) => run.status === "running").length;
  }

  totalRuns(): number {
    return this.runs.size;
  }

  previousCompletedRunId(runId: string): string {
    const index = this.orderedRunIds.indexOf(runId);
    if (index <= 0) {
      return "";
    }
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const run = this.runs.get(this.orderedRunIds[cursor]);
      if (run && run.status !== "running") {
        return run.id;
      }
    }
    return "";
  }

  latestStep(runId: string): TestStep | null {
    const stepIds = this.runSteps.get(runId) || [];
    const stepId = stepIds[stepIds.length - 1];
    return stepId ? this.steps.get(stepId) || null : null;
  }

  private normalizeTarget(value: string | undefined): TestTarget {
    return value === "web" || value === "miniapp" || value === "mixed" ? value : "mixed";
  }

  private normalizeRunStatus(value: string | undefined): RunStatus {
    return value === "running" || value === "passed" || value === "failed" || value === "aborted" ? value : "passed";
  }

  private normalizeStepStatus(value: string | undefined): StepStatus {
    return value === "running" || value === "passed" || value === "failed" || value === "aborted" ? value : "passed";
  }

  private normalizeStepKind(value: string | undefined): TestStep["kind"] {
    return value === "setup" ||
      value === "navigate" ||
      value === "action" ||
      value === "assert" ||
      value === "network" ||
      value === "custom"
      ? value
      : "custom";
  }
}
