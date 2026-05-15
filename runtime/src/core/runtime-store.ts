import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  AuthProfileRef,
  BlackboxActionTrace,
  BenchmarkRunReport,
  EvidenceCapsule,
  BlackboxExportArtifact,
  LocatorRepairCandidate,
  BlackboxPlan,
  BlackboxRunReport,
  EvidenceRefs,
  HarnessRun,
  HarnessVerificationReport,
  RuntimeArtifactManifest,
  RuntimeArtifactManifestEntry,
  RelayLogEvent,
  ScenarioRunReport,
  TestRun,
  TestStep,
} from "../types.js";

function safeName(value: string): string {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function listJson(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export interface RuntimeStoreSnapshot {
  runs: TestRun[];
  steps: TestStep[];
  events: RelayLogEvent[];
  scenarioReports: ScenarioRunReport[];
  blackboxPlans: BlackboxPlan[];
  blackboxReports: BlackboxRunReport[];
  blackboxActionTraces: BlackboxActionTrace[];
  blackboxExports: BlackboxExportArtifact[];
  evidenceCapsules: EvidenceCapsule[];
  locatorRepairs: LocatorRepairCandidate[];
  authProfiles: AuthProfileRef[];
  benchmarkReports: BenchmarkRunReport[];
  harnessRuns: HarnessRun[];
  harnessReports: HarnessVerificationReport[];
}

export class RuntimeArtifactStore {
  private readonly root: string;

  constructor(storeDir: string) {
    this.root = path.isAbsolute(storeDir) ? storeDir : path.join(process.cwd(), storeDir);
  }

  load(): RuntimeStoreSnapshot {
    return {
      runs: listJson(this.dir("runs")).map((file) => readJson<TestRun>(file)).filter((item): item is TestRun => Boolean(item)),
      steps: listJson(this.dir("steps")).map((file) => readJson<TestStep>(file)).filter((item): item is TestStep => Boolean(item)),
      events: listJson(this.dir("events")).map((file) => readJson<RelayLogEvent>(file)).filter((item): item is RelayLogEvent => Boolean(item)),
      scenarioReports: listJson(this.dir("scenario-reports")).map((file) => readJson<ScenarioRunReport>(file)).filter((item): item is ScenarioRunReport => Boolean(item)),
      blackboxPlans: listJson(this.dir("blackbox-plans")).map((file) => readJson<BlackboxPlan>(file)).filter((item): item is BlackboxPlan => Boolean(item)),
      blackboxReports: listJson(this.dir("blackbox-reports")).map((file) => readJson<BlackboxRunReport>(file)).filter((item): item is BlackboxRunReport => Boolean(item)),
      blackboxActionTraces: listJson(this.dir("blackbox-traces")).map((file) => readJson<BlackboxActionTrace>(file)).filter((item): item is BlackboxActionTrace => Boolean(item)),
      blackboxExports: listJson(this.dir("blackbox-exports")).map((file) => readJson<BlackboxExportArtifact>(file)).filter((item): item is BlackboxExportArtifact => Boolean(item)),
      evidenceCapsules: listJson(this.dir("evidence-capsules")).map((file) => readJson<EvidenceCapsule>(file)).filter((item): item is EvidenceCapsule => Boolean(item)),
      locatorRepairs: listJson(this.dir("locator-repairs")).map((file) => readJson<LocatorRepairCandidate>(file)).filter((item): item is LocatorRepairCandidate => Boolean(item)),
      authProfiles: listJson(this.dir("auth-profiles")).map((file) => readJson<AuthProfileRef>(file)).filter((item): item is AuthProfileRef => Boolean(item)),
      benchmarkReports: listJson(this.dir("benchmarks")).map((file) => readJson<BenchmarkRunReport>(file)).filter((item): item is BenchmarkRunReport => Boolean(item)),
      harnessRuns: listJson(this.dir("harness-runs")).map((file) => readJson<HarnessRun>(file)).filter((item): item is HarnessRun => Boolean(item)),
      harnessReports: listJson(this.dir("harness-reports")).map((file) => readJson<HarnessVerificationReport>(file)).filter((item): item is HarnessVerificationReport => Boolean(item)),
    };
  }

  saveRun(run: TestRun): string {
    return this.write("runs", run.id, run);
  }

  saveStep(step: TestStep): string {
    return this.write("steps", step.id, step);
  }

  saveEvent(event: RelayLogEvent): string {
    return this.write("events", `${String(event.sequence).padStart(12, "0")}-${event.id}`, event);
  }

  saveScenarioReport(runId: string, report: ScenarioRunReport): string {
    return this.write("scenario-reports", runId, report);
  }

  saveBlackboxPlan(plan: BlackboxPlan): string {
    return this.write("blackbox-plans", plan.planId, plan);
  }

  saveBlackboxReport(report: BlackboxRunReport): string {
    return this.write("blackbox-reports", report.runId, report);
  }

  saveBlackboxActionTrace(trace: BlackboxActionTrace): string {
    const traceKey = `${trace.runId}-${trace.caseId}-${trace.stepId || safeName(trace.generatedAt)}`;
    const filePath = this.write("blackbox-traces", traceKey, trace);
    this.saveEvidenceArtifact(trace.runId, `${trace.caseId}.${trace.stepId || safeName(trace.generatedAt)}.trace`, "json", `${JSON.stringify(trace, null, 2)}\n`);
    return filePath;
  }

  savePlaywrightTrace(runId: string, caseId: string, sourcePath: string): string {
    const dir = this.dir(path.join("evidence", safeName(runId)));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${safeName(caseId)}.playwright-trace.zip`);
    fs.copyFileSync(sourcePath, filePath);
    return filePath;
  }

  saveLocatorRepair(repair: LocatorRepairCandidate): string {
    const filePath = this.write("locator-repairs", `${repair.runId}-${repair.caseId}-${repair.stepId}`, repair);
    this.saveEvidenceArtifact(repair.runId, `${repair.caseId}.${repair.stepId}.locator-repair`, "json", `${JSON.stringify(repair, null, 2)}\n`);
    return filePath;
  }

  listBlackboxActionTraces(runId: string): BlackboxActionTrace[] {
    return listJson(this.dir("blackbox-traces"))
      .map((file) => readJson<BlackboxActionTrace>(file))
      .filter((item): item is BlackboxActionTrace => Boolean(item && item.runId === runId));
  }

  saveBlackboxExport(artifact: BlackboxExportArtifact): string {
    const filePath = this.saveEvidenceArtifact(artifact.runId, `blackbox-export.${artifact.format}`, "spec.ts", artifact.content);
    this.write("blackbox-exports", `${artifact.runId}-${artifact.format}`, { ...artifact, filePath });
    return filePath;
  }

  saveEvidenceCapsule(capsule: EvidenceCapsule): string {
    const filePath = this.write("evidence-capsules", capsule.runId, capsule);
    this.saveEvidenceArtifact(capsule.runId, "evidence-capsule", "json", `${JSON.stringify(capsule, null, 2)}\n`);
    return filePath;
  }

  getEvidenceCapsule(runId: string): EvidenceCapsule | null {
    return readJson<EvidenceCapsule>(this.file("evidence-capsules", runId));
  }

  saveAuthProfile(profile: AuthProfileRef, storageStateBody: string | Buffer): AuthProfileRef {
    const storageStateRef = this.saveEvidenceArtifact(`auth-${safeName(profile.name)}`, "storage-state", "json", storageStateBody);
    const stored = { ...profile, storageStateRef };
    this.write("auth-profiles", profile.name, stored);
    return stored;
  }

  getAuthProfile(name: string): AuthProfileRef | null {
    return readJson<AuthProfileRef>(this.file("auth-profiles", name));
  }

  saveBenchmarkReport(report: BenchmarkRunReport): string {
    return this.write("benchmarks", report.benchmarkId, report);
  }

  saveHarnessRun(run: HarnessRun): string {
    return this.write("harness-runs", run.harnessRunId, run);
  }

  saveHarnessReport(report: HarnessVerificationReport): string {
    return this.write("harness-reports", report.harnessRunId, report);
  }

  getHarnessReport(harnessRunId: string): HarnessVerificationReport | null {
    return readJson<HarnessVerificationReport>(this.file("harness-reports", harnessRunId));
  }

  readArtifactRef(ref: string): { path: string; contentType: string; encoding: "utf8" | "base64"; content: string } | null {
    const absolute = path.resolve(ref);
    const root = path.resolve(this.root);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      return null;
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return null;
    }
    const extension = path.extname(absolute).toLowerCase();
    const binary = [".png", ".jpg", ".jpeg", ".webp", ".zip"].includes(extension);
    const content = fs.readFileSync(absolute, binary ? undefined : "utf8");
    return {
      path: absolute,
      contentType: extension === ".png" ? "image/png" : extension === ".zip" ? "application/zip" : extension === ".ts" ? "text/typescript" : "application/json",
      encoding: binary ? "base64" : "utf8",
      content: Buffer.isBuffer(content) ? content.toString("base64") : content,
    };
  }

  artifactManifestForRun(runId: string): RuntimeArtifactManifest {
    return this.writeManifest(this.buildManifestForRun(runId));
  }

  artifactManifestForHarnessRun(harnessRunId: string, refs: string[]): RuntimeArtifactManifest {
    return this.writeManifest(this.buildManifestForHarnessRun(harnessRunId, refs));
  }

  inspect(input: { runId?: string; harnessRunId?: string; refs?: string[] }): RuntimeArtifactManifest {
    if (input.runId) return this.buildManifestForRun(input.runId);
    if (input.harnessRunId) return this.buildManifestForHarnessRun(input.harnessRunId, input.refs || []);
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      entries: [],
    };
  }

  private buildManifestForRun(runId: string): RuntimeArtifactManifest {
    const refs = [
      ...this.flattenEvidenceRefs(this.evidenceRefsFor(runId)),
      ...this.listEvidence(runId, "artifact-manifest.json"),
    ];
    return {
      schemaVersion: 1,
      ownerRunId: runId,
      generatedAt: new Date().toISOString(),
      entries: this.refsToManifestEntries(refs, { ownerRunId: runId }),
    };
  }

  private buildManifestForHarnessRun(harnessRunId: string, refs: string[]): RuntimeArtifactManifest {
    return {
      schemaVersion: 1,
      ownerHarnessRunId: harnessRunId,
      generatedAt: new Date().toISOString(),
      entries: this.refsToManifestEntries(refs, { ownerHarnessRunId: harnessRunId }),
    };
  }

  cleanup(input: { olderThanDays: number; dryRun?: boolean; confirm?: boolean }): { ok: boolean; dryRun: boolean; deleted: string[]; candidates: string[] } {
    const cutoff = Date.now() - Math.max(0, input.olderThanDays) * 24 * 60 * 60 * 1000;
    const candidates = this.walkFiles(this.root).filter((filePath) => {
      try {
        return fs.statSync(filePath).mtimeMs < cutoff;
      } catch {
        return false;
      }
    });
    const dryRun = input.dryRun !== false || input.confirm !== true;
    const deleted: string[] = [];
    if (!dryRun) {
      for (const filePath of candidates) {
        try {
          fs.unlinkSync(filePath);
          deleted.push(filePath);
        } catch {
          // Best-effort cleanup; inspect output reports what was actually removed.
        }
      }
    }
    return { ok: true, dryRun, deleted, candidates };
  }

  isEvidenceArtifactForRun(runId: string, ref: string, suffix?: string): boolean {
    const absolute = path.resolve(ref);
    const evidenceRoot = path.resolve(this.dir(path.join("evidence", safeName(runId))));
    if (absolute !== evidenceRoot && !absolute.startsWith(`${evidenceRoot}${path.sep}`)) {
      return false;
    }
    if (suffix && !absolute.endsWith(suffix)) {
      return false;
    }
    try {
      const fileStat = fs.statSync(absolute);
      return fileStat.isFile() && fileStat.size > 0;
    } catch {
      return false;
    }
  }

  listBlackboxExports(runId: string): BlackboxExportArtifact[] {
    return listJson(this.dir("blackbox-exports"))
      .map((file) => readJson<BlackboxExportArtifact>(file))
      .filter((item): item is BlackboxExportArtifact => Boolean(item && item.runId === runId));
  }

  saveEvidenceArtifact(runId: string, name: string, extension: string, body: string | Buffer): string {
    const dir = this.dir(path.join("evidence", safeName(runId)));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${safeName(name)}.${safeName(extension).replace(/^\./, "")}`);
    fs.writeFileSync(filePath, body);
    return filePath;
  }

  evidenceRefsFor(runId: string, planId?: string): EvidenceRefs {
    const eventFiles = listJson(this.dir("events")).filter((file) => {
      const event = readJson<RelayLogEvent>(file);
      return event?.runId === runId;
    });
    return {
      run: this.file("runs", runId),
      steps: listJson(this.dir("steps")).filter((file) => readJson<TestStep>(file)?.runId === runId),
      events: eventFiles,
      scenarioReport: this.file("scenario-reports", runId),
      blackboxPlan: planId ? this.file("blackbox-plans", planId) : undefined,
      blackboxReport: this.file("blackbox-reports", runId),
      screenshots: this.listEvidence(runId, ".png"),
      accessibility: this.listEvidence(runId, "-accessibility.json"),
      actionTraces: this.listEvidence(runId, ".trace.json"),
      playwrightTraces: this.listEvidence(runId, ".playwright-trace.zip"),
      locatorRepairs: this.listEvidence(runId, ".locator-repair.json"),
      evidenceCapsule: this.listEvidence(runId, "evidence-capsule.json")[0],
      exports: this.listEvidence(runId, ".spec.ts"),
    };
  }

  private listEvidence(runId: string, suffix: string): string[] {
    try {
      return fs.readdirSync(this.dir(path.join("evidence", safeName(runId))))
        .filter((name) => name.endsWith(suffix))
        .map((name) => path.join(this.dir(path.join("evidence", safeName(runId))), name));
    } catch {
      return [];
    }
  }

  private flattenEvidenceRefs(refs: EvidenceRefs): string[] {
    const values: string[] = [];
    const add = (value: unknown) => {
      if (typeof value === "string" && value.trim()) values.push(value);
    };
    const addMany = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(add);
    };
    add(refs.run);
    addMany(refs.steps);
    addMany(refs.events);
    add(refs.scenarioReport);
    add(refs.blackboxPlan);
    add(refs.blackboxReport);
    addMany(refs.screenshots);
    addMany(refs.accessibility);
    addMany(refs.actionTraces);
    addMany(refs.playwrightTraces);
    addMany(refs.locatorRepairs);
    add(refs.evidenceCapsule);
    addMany(refs.exports);
    return Array.from(new Set(values));
  }

  private refsToManifestEntries(refs: string[], owner: { ownerRunId?: string; ownerHarnessRunId?: string }): RuntimeArtifactManifestEntry[] {
    return refs
      .map((ref) => {
        try {
          const stat = fs.statSync(ref);
          if (!stat.isFile()) return null;
          const body = fs.readFileSync(ref);
          return {
            ref,
            kind: path.extname(ref).replace(/^\./, "") || "artifact",
            bytes: stat.size,
            sha256: createHash("sha256").update(body).digest("hex"),
            createdAt: stat.birthtime.toISOString(),
            ...owner,
          } satisfies RuntimeArtifactManifestEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is RuntimeArtifactManifestEntry => Boolean(entry));
  }

  private writeManifest(manifest: RuntimeArtifactManifest): RuntimeArtifactManifest {
    const owner = manifest.ownerHarnessRunId || manifest.ownerRunId || "store";
    const filePath = this.saveEvidenceArtifact(owner, "artifact-manifest", "json", `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      ...manifest,
      entries: [
        ...manifest.entries,
        ...this.refsToManifestEntries([filePath], manifest.ownerHarnessRunId ? { ownerHarnessRunId: manifest.ownerHarnessRunId } : { ownerRunId: manifest.ownerRunId }),
      ],
    };
  }

  private walkFiles(dir: string): string[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(dir, entry.name);
        return entry.isDirectory() ? this.walkFiles(fullPath) : [fullPath];
      });
    } catch {
      return [];
    }
  }

  private write(kind: string, id: string, payload: unknown): string {
    const filePath = this.file(kind, id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return filePath;
  }

  private file(kind: string, id: string): string {
    return path.join(this.dir(kind), `${safeName(id)}.json`);
  }

  private dir(kind: string): string {
    return path.join(this.root, kind);
  }
}
