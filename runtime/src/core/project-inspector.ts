import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type {
  MiniappProjectIntegrationReport,
  ProjectEntrypoint,
  ProjectProfile,
  SupportedTarget,
  TargetCapabilityReport,
  WebFramework,
  WebIntegrationReport,
} from "../types.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function collectFiles(root: string, depth = 4, currentDepth = 0): Promise<string[]> {
  if (currentDepth > depth) return [];
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await readdir(root, { withFileTypes: true }) as Array<{ name: string; isDirectory: () => boolean }>;
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute, depth, currentDepth + 1)));
    } else {
      files.push(absolute);
    }
  }
  return files;
}

async function collectDirectoriesWithMarker(root: string, marker: string, depth = 5, currentDepth = 0): Promise<string[]> {
  if (currentDepth > depth) return [];
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await readdir(root, { withFileTypes: true }) as Array<{ name: string; isDirectory: () => boolean }>;
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
    const absolute = path.join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (await pathExists(path.join(absolute, marker))) {
      dirs.push(absolute);
    }
    dirs.push(...(await collectDirectoriesWithMarker(absolute, marker, depth, currentDepth + 1)));
  }
  return dirs;
}

function toRelative(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return relative || ".";
}

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function detectWebFramework(pkg: Record<string, unknown>, files: string[]): WebFramework {
  const deps = {
    ...(pkg.dependencies as Record<string, unknown> | undefined),
    ...(pkg.devDependencies as Record<string, unknown> | undefined),
  };
  if ("next" in deps) return "nextjs";
  if ("@tarojs/taro" in deps) return "taro-h5";
  if ("@dcloudio/uni-app" in deps || files.some((file) => file.endsWith("pages.json"))) return "uniapp-h5";
  if ("vue" in deps && "vite" in deps) return "vue-vite";
  if ("react" in deps && "vite" in deps) return "react-vite";
  if ("react" in deps) return "generic-web";
  return "unknown";
}

function frameworkEntrypoints(root: string, framework: WebFramework, files: string[]): ProjectEntrypoint[] {
  const candidates: Array<ProjectEntrypoint & { match: (relative: string) => boolean }> = [
    { path: "", role: "bootstrap", match: (file) => /src\/main\.(t|j)sx?$/.test(file) || /src\/index\.(t|j)sx?$/.test(file) },
    { path: "", role: "bootstrap", match: (file) => /^app\.(t|j)s$/.test(file) || /^main\.(t|j)s$/.test(file) },
    { path: "", role: "route", match: (file) => /router\/index\.(t|j)sx?$/.test(file) || /src\/router\.(t|j)sx?$/.test(file) },
    { path: "", role: "network", match: (file) => /(api|request|http|fetch)\.(t|j)sx?$/.test(path.basename(file)) },
    { path: "", role: "error-boundary", match: (file) => /error\.(t|j)sx?$/.test(path.basename(file)) || /boundary/i.test(path.basename(file)) },
  ];
  if (framework === "nextjs") {
    candidates.push(
      { path: "", role: "bootstrap", match: (file) => /^app\/layout\.(t|j)sx?$/.test(file) || /^pages\/_app\.(t|j)sx?$/.test(file) },
      { path: "", role: "error-boundary", match: (file) => /^app\/error\.(t|j)sx?$/.test(file) || /^pages\/_error\.(t|j)sx?$/.test(file) },
    );
  }
  return files
    .map((absolute) => toRelative(root, absolute))
    .flatMap((relative) =>
      candidates.filter((candidate) => candidate.match(relative)).map((candidate) => ({
        path: relative,
        role: candidate.role,
      }))
    )
    .slice(0, 12);
}

function routeModeFor(framework: WebFramework, files: string[]): string {
  if (framework === "nextjs") {
    if (files.some((file) => file.startsWith("app/"))) return "next-app-router";
    if (files.some((file) => file.startsWith("pages/"))) return "next-pages-router";
  }
  if (framework === "taro-h5") return "taro-pages";
  if (framework === "uniapp-h5") return "uni-pages";
  if (files.some((file) => /react-router|router/i.test(file))) return "react-router-like";
  if (files.some((file) => /vue-router|router/i.test(file))) return "vue-router-like";
  return "unknown";
}

function scoreWebRoot(root: string, pkg: Record<string, unknown>, files: string[]): number {
  const framework = detectWebFramework(pkg, files);
  const entrypoints = frameworkEntrypoints(root, framework, files.map((file) => path.join(root, file)));
  return [
    framework !== "unknown" ? 8 : 0,
    entrypoints.some((item) => item.role === "bootstrap") ? 5 : 0,
    entrypoints.some((item) => item.role === "route") ? 3 : 0,
    entrypoints.some((item) => item.role === "network") ? 3 : 0,
    entrypoints.some((item) => item.role === "error-boundary") ? 2 : 0,
    files.some((file) => /^src\//.test(file)) ? 2 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

export class ProjectInspector {
  constructor(private readonly projectRoot: string) {}

  private async resolveWebRoot(): Promise<string> {
    const candidateRoots = [this.projectRoot, ...(await collectDirectoriesWithMarker(this.projectRoot, "package.json", 5))];
    let bestRoot = this.projectRoot;
    let bestScore = -1;
    for (const candidate of candidateRoots) {
      const pkg = await readJson(path.join(candidate, "package.json"));
      const files = (await collectFiles(candidate, 4)).map((file) => toRelative(candidate, file));
      const score = scoreWebRoot(candidate, pkg, files);
      if (score > bestScore) {
        bestScore = score;
        bestRoot = candidate;
      }
    }
    return bestRoot;
  }

  private async resolveMiniappRoot(): Promise<string> {
    const direct = await pathExists(path.join(this.projectRoot, "app.json")) || await pathExists(path.join(this.projectRoot, "project.config.json"));
    if (direct) {
      return this.projectRoot;
    }
    const candidates = [
      ...(await collectDirectoriesWithMarker(this.projectRoot, "app.json", 5)),
      ...(await collectDirectoriesWithMarker(this.projectRoot, "project.config.json", 5)),
    ];
    return candidates[0] || this.projectRoot;
  }

  async identify(target?: string): Promise<{ target: string; supportedTarget: SupportedTarget | null; framework: WebFramework | "miniapp"; projectRoot: string }> {
    const normalized = String(target || "").trim().toLowerCase();
    if (normalized === "miniapp") {
      const projectRoot = await this.resolveMiniappRoot();
      return { target: "miniapp", supportedTarget: "miniapp", framework: "miniapp", projectRoot };
    }
    if (normalized === "web") {
      const projectRoot = await this.resolveWebRoot();
      const files = await collectFiles(projectRoot, 4);
      const pkg = await readJson(path.join(projectRoot, "package.json"));
      return {
        target: "web",
        supportedTarget: "web",
        framework: detectWebFramework(pkg, files.map((file) => toRelative(projectRoot, file))),
        projectRoot,
      };
    }
    if (await pathExists(path.join(this.projectRoot, "app.json")) || await pathExists(path.join(this.projectRoot, "project.config.json"))) {
      return { target: "miniapp", supportedTarget: "miniapp", framework: "miniapp", projectRoot: this.projectRoot };
    }
    if (await pathExists(path.join(this.projectRoot, "package.json"))) {
      const projectRoot = await this.resolveWebRoot();
      const files = await collectFiles(projectRoot, 4);
      const pkg = await readJson(path.join(projectRoot, "package.json"));
      return {
        target: "web",
        supportedTarget: "web",
        framework: detectWebFramework(pkg, files.map((file) => toRelative(projectRoot, file))),
        projectRoot,
      };
    }
    const miniappRoot = await this.resolveMiniappRoot();
    if (miniappRoot !== this.projectRoot) {
      return { target: "miniapp", supportedTarget: "miniapp", framework: "miniapp", projectRoot: miniappRoot };
    }
    const webRoot = await this.resolveWebRoot();
    if (webRoot !== this.projectRoot) {
      const files = await collectFiles(webRoot, 4);
      const pkg = await readJson(path.join(webRoot, "package.json"));
      return {
        target: "web",
        supportedTarget: "web",
        framework: detectWebFramework(pkg, files.map((file) => toRelative(webRoot, file))),
        projectRoot: webRoot,
      };
    }
    return { target: normalized || "unknown", supportedTarget: null, framework: "unknown", projectRoot: this.projectRoot };
  }

  async inspectWeb(): Promise<WebIntegrationReport> {
    const root = await this.resolveWebRoot();
    const pkg = await readJson(path.join(root, "package.json"));
    const files = (await collectFiles(root, 5)).map((file) => toRelative(root, file));
    const framework = detectWebFramework(pkg, files);
    const entrypoints = frameworkEntrypoints(root, framework, files.map((file) => path.join(root, file)));
    const networkLayerCandidates = entrypoints.filter((item) => item.role === "network").map((item) => item.path);
    const errorBoundaryCandidates = entrypoints.filter((item) => item.role === "error-boundary").map((item) => item.path);
    const routeMode = routeModeFor(framework, files);
    const blockingIssues: string[] = [];
    if (!entrypoints.some((item) => item.role === "bootstrap")) blockingIssues.push("missing_bootstrap_entrypoint");
    if (routeMode === "unknown") blockingIssues.push("missing_route_layer_hint");
    if (networkLayerCandidates.length === 0) blockingIssues.push("missing_network_layer_candidate");
    if (errorBoundaryCandidates.length === 0) blockingIssues.push("missing_error_boundary_candidate");
    return {
      target: "web",
      framework,
      entrypoints,
      routeMode,
      networkLayerCandidates,
      errorBoundaryCandidates,
      relayInsertionReadiness: blockingIssues.length === 0 ? "ready" : entrypoints.length > 0 ? "partial" : "blocked",
      blockingIssues,
      recommendedActions: [
        ...(!entrypoints.some((item) => item.role === "bootstrap") ? ["Identify and instrument the main bootstrap entry before autoloop."] : []),
        ...(routeMode === "unknown" ? ["Attach route instrumentation at the router or top-level navigation layer."] : []),
        ...(networkLayerCandidates.length === 0 ? ["Instrument fetch/XHR or the shared request wrapper before runtime verification."] : []),
        ...(errorBoundaryCandidates.length === 0 ? ["Add a top-level error boundary or error page relay hook."] : []),
      ],
    };
  }

  async inspectMiniapp(): Promise<MiniappProjectIntegrationReport> {
    const root = await this.resolveMiniappRoot();
    const appEntry = (await pathExists(path.join(root, "app.ts")))
      ? "app.ts"
      : (await pathExists(path.join(root, "app.js")))
        ? "app.js"
        : "";
    const appJson = await readJson(path.join(root, "app.json"));
    const pages = Array.isArray(appJson.pages) ? appJson.pages.map((item) => String(item)) : [];
    const files = await collectFiles(root, 5);
    const fileTexts = await Promise.all(files.map(async (file) => ({ file, text: await readText(file) })));
    const componentFiles = files.filter((file) => /component/i.test(file) || /components\//.test(file));
    const wrapperHits = fileTexts.filter(({ text }) => includesAny(text, ["wrapApp(", "wrapPage(", "wrapComponent("]));
    const patchHits = fileTexts.filter(({ text }) => includesAny(text, ["enableMiniappRuntimePatch(", "wx.request", "navigateTo(", "redirectTo("]));
    const lifecycleHits = fileTexts.filter(({ text }) => includesAny(text, ["onLaunch", "onShow", "onLoad", "onReady", "onUnload"]));
    const routeHits = fileTexts.filter(({ text }) => includesAny(text, ["navigateTo(", "redirectTo(", "switchTab(", "reLaunch(", "navigateBack("]));
    const networkHits = fileTexts.filter(({ text }) => includesAny(text, ["wx.request(", "request(", "http(", "fetch("]));
    const wrapperCoverage = wrapperHits.length > 0 ? 100 : 0;
    const patchCoverage = patchHits.length > 0 ? 100 : 0;
    const routeCoverage = routeHits.length > 0 ? 100 : 0;
    const lifecycleCoverage = lifecycleHits.length > 0 ? 100 : 0;
    const networkCoverage = networkHits.length > 0 ? 100 : 0;
    const blockingIssues: string[] = [];
    if (!appEntry) blockingIssues.push("missing_app_entry");
    if (pages.length === 0) blockingIssues.push("missing_page_registration");
    if (wrapperCoverage === 0) blockingIssues.push("missing_wrapper_integration");
    if (lifecycleCoverage === 0) blockingIssues.push("missing_lifecycle_sampling");
    if (routeCoverage === 0 && networkCoverage === 0) blockingIssues.push("missing_route_or_network_signal_hint");
    return {
      target: "miniapp",
      status: blockingIssues.length === 0 ? "supported" : appEntry ? "partial" : "unsupported",
      appEntry,
      pageCoverage: pages.length > 0 ? 100 : 0,
      componentCoverage: componentFiles.length > 0 ? 100 : 0,
      wrapperCoverage,
      patchCoverage,
      routeCoverage,
      lifecycleCoverage,
      networkCoverage,
      blockingIssues,
      recommendedActions: [
        ...(!appEntry ? ["Create or expose the Miniapp app entry before relay verification."] : []),
        ...(wrapperCoverage === 0 ? ["Adopt wrapApp/wrapPage/wrapComponent as the default Miniapp integration mode."] : []),
        ...(lifecycleCoverage === 0 ? ["Expose lifecycle hooks so verify can prove continuity."] : []),
        ...(routeCoverage === 0 && networkCoverage === 0 ? ["Capture route APIs or wx.request before diagnosis."] : []),
      ],
    };
  }

  toProfile(args: {
    target: SupportedTarget;
    framework: WebFramework | "miniapp";
    integrationMode: string;
    knownEntrypoints: string[];
    knownSignalGaps: string[];
    projectRoot?: string;
  }): ProjectProfile {
    const projectRoot = args.projectRoot || this.projectRoot;
    const projectId = `${path.basename(projectRoot)}:${args.target}:${args.framework}`;
    return {
      projectId,
      projectRoot,
      target: args.target,
      framework: args.framework,
      integrationMode: args.integrationMode,
      knownEntrypoints: args.knownEntrypoints,
      knownSignalGaps: args.knownSignalGaps,
      lastVerifiedAt: new Date().toISOString(),
    };
  }
}

export function supportToProjectStatus(report: TargetCapabilityReport): "supported" | "partial" | "unsupported" {
  return report.status === "inapplicable" ? "unsupported" : report.status;
}
