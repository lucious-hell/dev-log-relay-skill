import { randomUUID } from "node:crypto";
import type {
  AutoloopAttempt,
  AutoloopAttemptCompleteInput,
  AutoloopAttemptStartInput,
  AutoloopSession,
  AutoloopStartInput,
  AutoloopStatus,
  RepairOutcome,
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

export class AutoloopStore {
  private readonly sessions = new Map<string, AutoloopSession>();
  private readonly sessionByRun = new Map<string, string>();
  private readonly attempts = new Map<string, AutoloopAttempt[]>();
  private readonly repairOutcomes = new Map<string, RepairOutcome>();
  private readonly decisions = new Map<string, AutoloopAttemptCompleteInput["stopDecision"]>();

  start(runId: string, input: AutoloopStartInput, target: TestTarget): AutoloopSession {
    const session: AutoloopSession = {
      id: randomUUID(),
      runId,
      status: "collecting",
      triggerReason: String(input.triggerReason || "task_runtime_change").slice(0, 200),
      targetSurface: target,
      attemptCount: 0,
      maxAttempts: Number.isFinite(input.maxAttempts) && Number(input.maxAttempts) > 0 ? Number(input.maxAttempts) : 3,
      startedAt: nowIso(),
      endedAt: "",
      entryContext: asObject(input.entryContext),
    };
    this.sessions.set(session.id, session);
    this.sessionByRun.set(runId, session.id);
    this.attempts.set(session.id, []);
    return session;
  }

  getById(sessionId: string): AutoloopSession | null {
    return this.sessions.get(sessionId) || null;
  }

  getByRunId(runId: string): AutoloopSession | null {
    const sessionId = this.sessionByRun.get(runId);
    return sessionId ? this.sessions.get(sessionId) || null : null;
  }

  setStatus(sessionId: string, status: AutoloopStatus): AutoloopSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    session.status = status;
    if (status === "resolved" || status === "halted") {
      session.endedAt = nowIso();
    }
    return session;
  }

  startAttempt(sessionId: string, input: AutoloopAttemptStartInput): AutoloopAttempt | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    const list = this.attempts.get(sessionId) || [];
    const attempt: AutoloopAttempt = {
      id: randomUUID(),
      sessionId,
      attemptIndex: list.length + 1,
      baselineRunId: String(input.baselineRunId || "").slice(0, 200),
      currentRunId: String(input.currentRunId || "").slice(0, 200),
      diagnosisSnapshot: null,
      repairPlanSummary: "",
      result: "",
      createdAt: nowIso(),
      completedAt: "",
    };
    list.push(attempt);
    this.attempts.set(sessionId, list);
    session.attemptCount = list.length;
    if (attempt.currentRunId) {
      this.sessionByRun.set(attempt.currentRunId, sessionId);
    }
    return attempt;
  }

  completeAttempt(sessionId: string, attemptId: string, input: AutoloopAttemptCompleteInput): AutoloopAttempt | null {
    const attempt = this.getAttempt(sessionId, attemptId);
    if (!attempt) {
      return null;
    }
    attempt.result = String(input.result || "").slice(0, 1000);
    attempt.completedAt = nowIso();
    if (input.stopDecision) {
      this.decisions.set(sessionId, input.stopDecision);
    }
    return attempt;
  }

  annotateAttempt(sessionId: string, attemptId: string, patch: Partial<Pick<AutoloopAttempt, "diagnosisSnapshot" | "repairPlanSummary">>): AutoloopAttempt | null {
    const attempt = this.getAttempt(sessionId, attemptId);
    if (!attempt) {
      return null;
    }
    if ("diagnosisSnapshot" in patch) {
      attempt.diagnosisSnapshot = patch.diagnosisSnapshot ?? null;
    }
    if ("repairPlanSummary" in patch) {
      attempt.repairPlanSummary = String(patch.repairPlanSummary || "").slice(0, 1000);
    }
    return attempt;
  }

  setRepairOutcome(sessionId: string, attemptId: string, outcome: RepairOutcome): RepairOutcome | null {
    const attempt = this.getAttempt(sessionId, attemptId);
    if (!attempt) {
      return null;
    }
    this.repairOutcomes.set(attempt.id, outcome);
    return outcome;
  }

  getRepairOutcome(attemptId: string): RepairOutcome | null {
    return this.repairOutcomes.get(attemptId) || null;
  }

  getAttempt(sessionId: string, attemptId: string): AutoloopAttempt | null {
    const list = this.attempts.get(sessionId) || [];
    return list.find((attempt) => attempt.id === attemptId) || null;
  }

  listAttempts(sessionId: string): AutoloopAttempt[] {
    return [...(this.attempts.get(sessionId) || [])];
  }

  getDecision(sessionId: string) {
    return this.decisions.get(sessionId) || null;
  }

  totalSessions(): number {
    return this.sessions.size;
  }
}
