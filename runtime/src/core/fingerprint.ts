import { createHash } from "node:crypto";
import type { RelayLogEvent } from "../types.js";

function normalizeText(value: string): string {
  return String(value || "")
    .replace(/\d{2,}/g, "#")
    .replace(/[a-f0-9]{8,}/gi, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function stackTop(stack: string): string {
  return String(stack || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("|");
}

export function buildFingerprint(
  event: Pick<RelayLogEvent, "level" | "message" | "stack" | "route" | "source"> & Partial<Pick<RelayLogEvent, "phase" | "errorKind" | "component">>
): string {
  const basis = [
    event.source,
    event.level,
    normalizeText(event.phase || ""),
    normalizeText(event.errorKind || ""),
    normalizeText(event.component || ""),
    normalizeText(event.route || ""),
    normalizeText(event.message || ""),
    normalizeText(stackTop(event.stack || "")),
  ].join("::");
  return createHash("sha1").update(basis).digest("hex");
}
