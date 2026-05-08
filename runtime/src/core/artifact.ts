import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { DiagnosisArtifact } from "../types.js";

export async function writeArtifact(artifactDir: string, fileName: string, artifact: DiagnosisArtifact): Promise<string> {
  const absoluteDir = path.isAbsolute(artifactDir) ? artifactDir : path.join(process.cwd(), artifactDir);
  await mkdir(absoluteDir, { recursive: true });
  const filePath = path.join(absoluteDir, fileName);
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return filePath;
}
