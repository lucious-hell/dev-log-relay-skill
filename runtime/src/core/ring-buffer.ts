import type { RelayLogEvent } from "../types.js";

export class RingBuffer {
  private readonly events: RelayLogEvent[] = [];

  constructor(private readonly maxSize: number) {}

  push(event: RelayLogEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.splice(0, this.events.length - this.maxSize);
    }
  }

  listRecent(limit = 200): RelayLogEvent[] {
    if (limit <= 0) {
      return [];
    }
    return this.events.slice(-limit);
  }

  listByFingerprint(fingerprint: string, limit = 200): RelayLogEvent[] {
    const matched = this.events.filter((event) => event.fingerprint === fingerprint);
    if (limit <= 0) {
      return matched;
    }
    return matched.slice(-limit);
  }

  aroundEvent(eventId: string, before = 20, after = 20): RelayLogEvent[] {
    const index = this.events.findIndex((event) => event.id === eventId);
    if (index < 0) {
      return [];
    }
    const start = Math.max(0, index - Math.max(0, before));
    const end = Math.min(this.events.length, index + Math.max(0, after) + 1);
    return this.events.slice(start, end);
  }

  size(): number {
    return this.events.length;
  }
}
