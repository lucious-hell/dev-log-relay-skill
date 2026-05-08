import type { LogSource, RelayIncident, RelayLogEvent } from "../types.js";

interface IncidentEventRef {
  id: string;
  timestamp: string;
  runId: string;
  sequence: number;
  level: RelayLogEvent["level"];
  source: RelayLogEvent["source"];
  route: string;
}

interface IncidentInternal {
  fingerprint: string;
  firstSeen: string;
  lastSeen: string;
  level: RelayLogEvent["level"];
  sourceBreakdown: Record<LogSource, number>;
  routeBreakdown: Record<string, number>;
  sampleMessage: string;
  sampleStack: string;
  latestRunId: string;
  refs: IncidentEventRef[];
}

function emptySourceBreakdown(): Record<LogSource, number> {
  return {
    miniapp: 0,
    "admin-web": 0,
    backend: 0,
  };
}

export class IncidentStore {
  private readonly incidents = new Map<string, IncidentInternal>();

  upsert(event: RelayLogEvent): void {
    const existed = this.incidents.get(event.fingerprint);
    if (!existed) {
      const sourceBreakdown = emptySourceBreakdown();
      sourceBreakdown[event.source] = 1;
      this.incidents.set(event.fingerprint, {
        fingerprint: event.fingerprint,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        level: event.level,
        sourceBreakdown,
        routeBreakdown: event.route ? { [event.route]: 1 } : {},
        sampleMessage: event.message,
        sampleStack: event.stack,
        latestRunId: event.runId,
        refs: [this.toRef(event)],
      });
      return;
    }
    existed.lastSeen = event.timestamp;
    existed.level = this.pickHigherLevel(existed.level, event.level);
    existed.latestRunId = event.runId || existed.latestRunId;
    existed.sourceBreakdown[event.source] = Number(existed.sourceBreakdown[event.source] || 0) + 1;
    if (event.route) {
      existed.routeBreakdown[event.route] = Number(existed.routeBreakdown[event.route] || 0) + 1;
    }
    existed.refs.push(this.toRef(event));
    if (existed.refs.length > 5000) {
      existed.refs.splice(0, existed.refs.length - 5000);
    }
  }

  listTop(options: {
    windowStartIso?: string;
    limit: number;
    runId?: string;
    previousRunId?: string;
  }): RelayIncident[] {
    return Array.from(this.incidents.values())
      .map((item) => this.toIncident(item, options.windowStartIso, options.runId, options.previousRunId))
      .filter((item): item is RelayIncident => Boolean(item))
      .sort((left, right) => {
        if (right.count !== left.count) {
          return right.count - left.count;
        }
        return right.lastSeen.localeCompare(left.lastSeen);
      })
      .slice(0, Math.max(0, options.limit));
  }

  countForRun(fingerprint: string, runId: string): number {
    const item = this.incidents.get(fingerprint);
    if (!item) {
      return 0;
    }
    return item.refs.filter((ref) => ref.runId === runId).length;
  }

  hasSeenOutsideRuns(fingerprint: string, runIds: string[]): boolean {
    const item = this.incidents.get(fingerprint);
    if (!item) {
      return false;
    }
    const excluded = new Set(runIds.filter(Boolean));
    return item.refs.some((ref) => ref.runId && !excluded.has(ref.runId));
  }

  listFingerprintsForRun(runId: string): string[] {
    return Array.from(this.incidents.values())
      .filter((item) => item.refs.some((ref) => ref.runId === runId))
      .map((item) => item.fingerprint);
  }

  getLatestEventId(fingerprint: string, runId?: string): string {
    const incident = this.incidents.get(fingerprint);
    if (!incident) {
      return "";
    }
    for (let index = incident.refs.length - 1; index >= 0; index -= 1) {
      const ref = incident.refs[index];
      if (!runId || ref.runId === runId) {
        return ref.id;
      }
    }
    return "";
  }

  private toIncident(
    item: IncidentInternal,
    windowStartIso?: string,
    runId?: string,
    previousRunId?: string
  ): RelayIncident | null {
    const refs = item.refs.filter((ref) => {
      if (windowStartIso && ref.timestamp < windowStartIso) {
        return false;
      }
      if (runId && ref.runId !== runId) {
        return false;
      }
      return true;
    });
    if (!refs.length) {
      return null;
    }
    const sourceBreakdown = emptySourceBreakdown();
    const routeBreakdown: Record<string, number> = {};
    for (const ref of refs) {
      sourceBreakdown[ref.source] = Number(sourceBreakdown[ref.source] || 0) + 1;
      if (ref.route) {
        routeBreakdown[ref.route] = Number(routeBreakdown[ref.route] || 0) + 1;
      }
    }
    const currentCount = runId ? item.refs.filter((ref) => ref.runId === runId).length : refs.length;
    const baselineCount = previousRunId ? item.refs.filter((ref) => ref.runId === previousRunId).length : 0;
    return {
      fingerprint: item.fingerprint,
      firstSeen: refs[0].timestamp,
      lastSeen: refs[refs.length - 1].timestamp,
      count: refs.length,
      level: item.level,
      sourceBreakdown,
      routeBreakdown,
      sampleMessage: item.sampleMessage,
      sampleStack: item.sampleStack,
      latestRunId: item.latestRunId,
      regressed: baselineCount === 0 && currentCount > 0 && Boolean(previousRunId),
      resolvedInCurrentRun: Boolean(previousRunId) && baselineCount > 0 && currentCount === 0,
    };
  }

  private toRef(event: RelayLogEvent): IncidentEventRef {
    return {
      id: event.id,
      timestamp: event.timestamp,
      runId: event.runId,
      sequence: event.sequence,
      level: event.level,
      source: event.source,
      route: event.route,
    };
  }

  private pickHigherLevel(left: RelayLogEvent["level"], right: RelayLogEvent["level"]): RelayLogEvent["level"] {
    const ranking = { debug: 1, info: 2, warn: 3, error: 4 };
    return ranking[right] > ranking[left] ? right : left;
  }
}
