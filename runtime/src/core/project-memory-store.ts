import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { ProjectKnowledgeSnapshot, ProjectMemoryRecord, ProjectProfile } from "../types.js";

interface StoredProjectBundle {
  profile: ProjectProfile;
  records: ProjectMemoryRecord[];
}

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class ProjectMemoryStore {
  private readonly profiles = new Map<string, ProjectProfile>();
  private readonly records = new Map<string, ProjectMemoryRecord[]>();

  constructor(private readonly memoryDir: string) {}

  private absoluteDir() {
    return path.isAbsolute(this.memoryDir) ? this.memoryDir : path.join(process.cwd(), this.memoryDir);
  }

  private bundlePath(projectId: string) {
    const safe = projectId.replace(/[^\w.-]+/g, "_");
    return path.join(this.absoluteDir(), `${safe}.json`);
  }

  async upsertProfile(profile: ProjectProfile): Promise<ProjectProfile> {
    this.profiles.set(profile.projectId, profile);
    const current = this.records.get(profile.projectId) || [];
    await this.persist(profile.projectId, { profile, records: current });
    return profile;
  }

  async appendRecord(record: ProjectMemoryRecord): Promise<ProjectMemoryRecord> {
    const current = this.records.get(record.projectId) || [];
    const stored: ProjectMemoryRecord = {
      ...record,
      recordFile: this.bundlePath(record.projectId),
    };
    current.push(stored);
    this.records.set(record.projectId, current);
    const profile = this.profiles.get(record.projectId);
    if (profile) {
      await this.persist(record.projectId, { profile, records: current });
    }
    return stored;
  }

  getProfile(projectId: string): ProjectProfile | null {
    return this.profiles.get(projectId) || null;
  }

  listRecords(projectId: string): ProjectMemoryRecord[] {
    return [...(this.records.get(projectId) || [])].reverse();
  }

  snapshot(projectId: string): ProjectKnowledgeSnapshot | null {
    const project = this.getProfile(projectId);
    if (!project) return null;
    const records = this.listRecords(projectId);
    const knownSignalGaps = Array.from(new Set([...(project.knownSignalGaps || []), ...records.flatMap((item) => item.integrationFixes)]));
    return {
      project,
      records,
      recentRunIds: records.slice(0, 10).map((item) => item.runId),
      knownSignalGaps,
      resolvedFingerprints: Array.from(new Set(records.flatMap((item) => item.resolvedFingerprints))).slice(0, 50),
      regressedFingerprints: Array.from(new Set(records.flatMap((item) => item.regressedFingerprints))).slice(0, 50),
    };
  }

  async loadAll(): Promise<void> {
    const dir = this.absoluteDir();
    await ensureDir(dir);
    const files = await readdir(dir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const bundle = await readJson<StoredProjectBundle>(path.join(dir, file), { profile: null as unknown as ProjectProfile, records: [] });
      if (!bundle.profile || !bundle.profile.projectId) continue;
      this.profiles.set(bundle.profile.projectId, bundle.profile);
      this.records.set(bundle.profile.projectId, Array.isArray(bundle.records) ? bundle.records : []);
    }
  }

  private async persist(projectId: string, bundle: StoredProjectBundle): Promise<void> {
    const dir = this.absoluteDir();
    await ensureDir(dir);
    await writeFile(this.bundlePath(projectId), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  }
}
