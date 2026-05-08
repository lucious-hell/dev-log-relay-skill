import type { RelayLogEvent } from "../types.js";

export class PriorityQueue {
  private readonly items: RelayLogEvent[] = [];

  constructor(private readonly maxPending: number) {}

  enqueue(event: RelayLogEvent): boolean {
    if (this.items.length >= this.maxPending) {
      const lowestIndex = this.findLowestPriorityIndex();
      if (lowestIndex < 0 || this.items[lowestIndex].priority >= event.priority) {
        return false;
      }
      this.items.splice(lowestIndex, 1);
    }
    this.items.push(event);
    return true;
  }

  dequeueBatch(limit: number): RelayLogEvent[] {
    if (!this.items.length || limit <= 0) {
      return [];
    }
    this.items.sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return left.timestamp.localeCompare(right.timestamp);
    });
    return this.items.splice(0, limit);
  }

  size(): number {
    return this.items.length;
  }

  private findLowestPriorityIndex(): number {
    if (!this.items.length) {
      return -1;
    }
    let minIndex = 0;
    for (let index = 1; index < this.items.length; index += 1) {
      if (this.items[index].priority < this.items[minIndex].priority) {
        minIndex = index;
      }
    }
    return minIndex;
  }
}
