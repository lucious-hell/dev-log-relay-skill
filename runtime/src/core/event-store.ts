import type { LogLevel, RelayLogEvent } from "../types.js";

export interface TimelineFilters {
  cursor?: number;
  level?: LogLevel;
  limit?: number;
}

export class EventStore {
  private readonly events: RelayLogEvent[] = [];
  private nextSequence = 1;

  constructor(private readonly maxSize: number) {}

  assignSequence(): number {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    return sequence;
  }

  push(event: RelayLogEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.splice(0, this.events.length - this.maxSize);
    }
  }

  size(): number {
    return this.events.length;
  }

  listRecent(limit = 200): RelayLogEvent[] {
    if (limit <= 0) {
      return [];
    }
    return this.events.slice(-limit);
  }

  listByRun(runId: string): RelayLogEvent[] {
    return this.events.filter((event) => event.runId === runId);
  }

  listByStep(runId: string, stepId: string): RelayLogEvent[] {
    return this.events.filter((event) => event.runId === runId && event.stepId === stepId);
  }

  listTimeline(runId: string, filters: TimelineFilters): RelayLogEvent[] {
    const limit = Math.max(1, filters.limit || 200);
    const cursor = Number.isFinite(filters.cursor) ? Number(filters.cursor) : 0;
    return this.events
      .filter((event) => event.runId === runId)
      .filter((event) => (cursor > 0 ? event.sequence > cursor : true))
      .filter((event) => this.matchesLevel(event.level, filters.level))
      .slice(0, limit);
  }

  aroundEvent(eventId: string, before = 20, after = 20, runId?: string): RelayLogEvent[] {
    const index = this.events.findIndex((event) => event.id === eventId && (!runId || event.runId === runId));
    if (index < 0) {
      return [];
    }
    const start = Math.max(0, index - Math.max(0, before));
    const end = Math.min(this.events.length, index + Math.max(0, after) + 1);
    const window = this.events.slice(start, end);
    return runId ? window.filter((event) => event.runId === runId) : window;
  }

  latestByFingerprint(fingerprint: string, runId?: string): RelayLogEvent | null {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event.fingerprint === fingerprint && (!runId || event.runId === runId)) {
        return event;
      }
    }
    return null;
  }

  private matchesLevel(actual: LogLevel, filter: LogLevel | undefined): boolean {
    if (!filter) {
      return true;
    }
    const ranking = { debug: 1, info: 2, warn: 3, error: 4 };
    return ranking[actual] >= ranking[filter];
  }
}
