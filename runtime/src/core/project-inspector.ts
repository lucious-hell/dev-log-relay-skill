import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type {
  EvidenceLayer,
  MiniappProjectIntegrationReport,
  ProjectResolutionReport,
  ProjectEntrypoint,
  ProjectProfile,
  SupportedTarget,
  TargetCapabilityReport,
  TargetDetectionReport,
  TargetSignal,
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

async function readJson(filePath: string): Promise<Record<string, any>> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, any>;
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

async function collectFiles(root: string, depth = 5, currentDepth = 0): Promise<string[]> {
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
    if (!entry.isDirectory()) continue;
    const absolute = path.join(root, entry.name);
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

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function frameworkFromDeps(pkg: Record<string, any>, files: string[]): WebFramework {
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  if ("next" in deps || files.some((file) => /^next\.config\./.test(file))) return "nextjs";
  if ("@tarojs/taro" in deps) return "taro-h5";
  if ("@dcloudio/uni-app" in deps || files.some((file) => file.endsWith("pages.json"))) return "uniapp-h5";
  if ("vue" in deps && "vite" in deps) return "vue-vite";
  if ("react" in deps && "vite" in deps) return "react-vite";
  if ("react" in deps || "vue" in deps) return "generic-web";
  return "unknown";
}

function toEvidenceLayerFromReady(ready: "ready" | "partial" | "blocked"): EvidenceLayer {
  if (ready === "ready") return "project_structure";
  if (ready === "partial") return "project_structure";
  return "project_structure";
}

interface MiniappAnalysis {
  root: string;
  projectConfigEntry: string;
  sourceRoot: string;
  workspaceRoot: string;
  appEntry: string;
  entries: string[];
  pageMap: string[];
  resolvedPageFiles: string[];
  subPackages: string[];
  pageRegistrationResolution: "resolved" | "partial" | "unresolved";
  structureAmbiguities: string[];
  componentFiles: string[];
  wrapperCoverage: number;
  patchCoverage: number;
  routeCoverage: number;
  lifecycleCoverage: number;
  networkCoverage: number;
  pageResolutionCoverage: number;
  blockingIssues: string[];
  recommendedActions: string[];
  signals: TargetSignal[];
}

interface MiniappRootResolution {
  root: string;
  projectConfigEntry: string;
  sourceRoot: string;
}

export class ProjectInspector {
  constructor(private readonly projectRoot: string) {}

  private async resolveWorkspaceTopology() {
    const pkg = await readJson(path.join(this.projectRoot, "package.json"));
    const appsDir = path.join(this.projectRoot, "apps");
    const packagesDir = path.join(this.projectRoot, "packages");
    const apps = (await pathExists(appsDir)) ? (await readdir(appsDir)).map((name) => `apps/${name}`) : [];
    const packages = (await pathExists(packagesDir)) ? (await readdir(packagesDir)).map((name) => `packages/${name}`) : [];
    const workspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces.map((item: unknown) => String(item))
      : Array.isArray(pkg.workspaces?.packages)
        ? pkg.workspaces.packages.map((item: unknown) => String(item))
        : [];
    return {
      monorepo: workspaces.length > 0 || apps.length > 0 || packages.length > 0,
      apps,
      packages,
      workspaces,
    };
  }

  private async resolveWebRoot(): Promise<string> {
    const candidates = uniq([this.projectRoot, ...(await collectDirectoriesWithMarker(this.projectRoot, "package.json", 5))]);
    let best = this.projectRoot;
    let bestScore = -1;
    for (const candidate of candidates) {
      const files = (await collectFiles(candidate, 5)).map((file) => toRelative(candidate, file));
      const pkg = await readJson(path.join(candidate, "package.json"));
      const framework = frameworkFromDeps(pkg, files);
      const score =
        (framework !== "unknown" ? 10 : 0) +
        (files.some((file) => /src\/(main|index)\.(t|j)sx?$/.test(file) || /^app\/layout\.(t|j)sx?$/.test(file)) ? 6 : 0) +
        (files.some((file) => /router|routes|pages/.test(file)) ? 3 : 0) +
        (files.some((file) => /(api|request|fetch|http)\.(t|j)sx?$/.test(path.basename(file))) ? 2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  private async resolveMiniappRoot(): Promise<MiniappRootResolution> {
    const projectConfigDirs = uniq([
      ...(await pathExists(path.join(this.projectRoot, "project.config.json")) ? [this.projectRoot] : []),
      ...(await collectDirectoriesWithMarker(this.projectRoot, "project.config.json", 6)),
    ]);
    const appJsonDirs = uniq([
      ...(await pathExists(path.join(this.projectRoot, "app.json")) ? [this.projectRoot] : []),
      ...(await collectDirectoriesWithMarker(this.projectRoot, "app.json", 6)),
    ]);

    const candidates: MiniappRootResolution[] = [];
    for (const configDir of projectConfigDirs) {
      const projectConfigEntry = path.join(configDir, "project.config.json");
      const projectConfig = await readJson(projectConfigEntry);
      const sourceRoot = String(projectConfig.miniprogramRoot || projectConfig.srcMiniprogramRoot || projectConfig.sourceRoot || "").trim();
      const resolvedRoot = sourceRoot ? path.resolve(configDir, sourceRoot) : configDir;
      candidates.push({
        root: resolvedRoot,
        projectConfigEntry,
        sourceRoot,
      });
      const commonRoots = ["miniprogram", "src/miniprogram", "client", "src"];
      for (const commonRoot of commonRoots) {
        candidates.push({
          root: path.resolve(configDir, commonRoot),
          projectConfigEntry,
          sourceRoot: commonRoot,
        });
      }
    }

    for (const root of appJsonDirs) {
      candidates.push({
        root,
        projectConfigEntry: "",
        sourceRoot: path.relative(this.projectRoot, root) || ".",
      });
    }

    const uniqueCandidates = uniq(candidates.map((item) => JSON.stringify(item))).map((encoded) => JSON.parse(encoded) as MiniappRootResolution);

    let best: MiniappRootResolution = {
      root: this.projectRoot,
      projectConfigEntry: await pathExists(path.join(this.projectRoot, "project.config.json")) ? path.join(this.projectRoot, "project.config.json") : "",
      sourceRoot: "",
    };
    let bestScore = -1;

    for (const candidate of uniqueCandidates) {
      const appJsonExists = await pathExists(path.join(candidate.root, "app.json"));
      const projectConfigExists = candidate.projectConfigEntry ? await pathExists(candidate.projectConfigEntry) : false;
      const score =
        (appJsonExists ? 30 : 0) +
        (projectConfigExists ? 10 : 0) +
        (candidate.sourceRoot && candidate.sourceRoot !== "." ? 6 : 0) +
        (candidate.root.includes("miniprogram") ? 4 : 0) +
        ((await pathExists(path.join(candidate.root, "pages"))) ? 3 : 0);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
  }

  private async analyzeMiniapp(resolution: MiniappRootResolution): Promise<MiniappAnalysis> {
    const root = resolution.root;
    const files = await collectFiles(root, 6);
    const relativeFiles = files.map((file) => toRelative(root, file));
    const appJson = await readJson(path.join(root, "app.json"));
    const appEntry =
      relativeFiles.find((file) => /(^|\/)app\.(t|j)s$/.test(file)) ||
      relativeFiles.find((file) => /miniprogram\/app\.(t|j)s$/.test(file)) ||
      "";
    const pages = Array.isArray(appJson.pages) ? appJson.pages.map((item) => String(item)) : [];
    const subPackages = Array.isArray(appJson.subPackages)
      ? appJson.subPackages.flatMap((item) => {
          const rootDir = String(item?.root || "");
          const pkgPages = Array.isArray(item?.pages) ? item.pages.map((page: unknown) => String(page)) : [];
          return pkgPages.map((page: string) => path.join(rootDir, page).replace(/\\/g, "/"));
        })
      : [];
    const pageMap = uniq([...pages, ...subPackages]).map((page) => page.replace(/^\//, ""));
    const componentFiles = relativeFiles.filter((file) => /components?\//.test(file) || /component/i.test(path.basename(file)));
    const textMap = await Promise.all(files.map(async (file) => ({ file: toRelative(root, file), text: await readText(file) })));
    const wrapperHits = textMap.filter(({ text }) => includesAny(text, ["wrapApp(", "wrapPage(", "wrapComponent("]));
    const patchHits = textMap.filter(({ text }) => includesAny(text, ["enableMiniappRuntimePatch(", "wx.request", "App(", "Page(", "Component("]));
    const routeHits = textMap.filter(({ text }) => includesAny(text, ["navigateTo(", "redirectTo(", "switchTab(", "reLaunch(", "navigateBack("]));
    const lifecycleHits = textMap.filter(({ text }) => includesAny(text, ["onLaunch", "onShow", "onHide", "onLoad", "onReady", "onUnload"]));
    const networkHits = textMap.filter(({ text }) => includesAny(text, ["wx.request(", "request(", "fetch(", "http("]));

    const existingPageFiles = pageMap.filter((page) =>
      relativeFiles.some((file) => file === `${page}.ts` || file === `${page}.js` || file.startsWith(`${page}.`))
    );

    const signals: TargetSignal[] = [
      ...(appEntry ? [{ kind: "file" as const, value: appEntry, weight: 6 }] : []),
      ...pageMap.slice(0, 6).map((value) => ({ kind: "config" as const, value: `page:${value}`, weight: 3 })),
      ...wrapperHits.slice(0, 4).map(({ file }) => ({ kind: "code_pattern" as const, value: `wrapper:${file}`, weight: 4 })),
      ...patchHits.slice(0, 4).map(({ file }) => ({ kind: "code_pattern" as const, value: `patch:${file}`, weight: 3 })),
      ...routeHits.slice(0, 4).map(({ file }) => ({ kind: "code_pattern" as const, value: `route:${file}`, weight: 2 })),
      ...networkHits.slice(0, 4).map(({ file }) => ({ kind: "code_pattern" as const, value: `network:${file}`, weight: 2 })),
    ];

    const pageResolutionCoverage = pageMap.length > 0 ? Math.round((existingPageFiles.length / pageMap.length) * 100) : 0;
    const structureAmbiguities: string[] = [];
    if (!resolution.projectConfigEntry) structureAmbiguities.push("project_config_not_found");
    if (!resolution.sourceRoot) structureAmbiguities.push("source_root_inferred");
    if (pageMap.length > existingPageFiles.length) structureAmbiguities.push("declared_pages_exceed_resolved_pages");
    const pageRegistrationResolution =
      pageMap.length === 0 || existingPageFiles.length === 0 ? "unresolved" : existingPageFiles.length === pageMap.length ? "resolved" : "partial";
    const wrapperCoverage = wrapperHits.length > 0 ? Math.min(100, Math.round((wrapperHits.length / Math.max(1, pageMap.length || 1)) * 100)) : 0;
    const patchCoverage = patchHits.length > 0 ? Math.min(100, 40 + patchHits.length * 10) : 0;
    const routeCoverage = routeHits.length > 0 ? 100 : pageResolutionCoverage > 0 && (wrapperCoverage > 0 || patchCoverage > 0) ? 60 : pageResolutionCoverage > 0 ? 20 : 0;
    const lifecycleCoverage = lifecycleHits.length > 0 ? 100 : wrapperCoverage > 0 && pageResolutionCoverage > 0 ? 60 : 0;
    const networkCoverage = networkHits.length > 0 ? 100 : 0;

    const blockingIssues: string[] = [];
    if (!appEntry) blockingIssues.push("missing_app_entry");
    if (pageMap.length === 0) blockingIssues.push("missing_page_registration");
    if (pageMap.length > 0 && existingPageFiles.length === 0) blockingIssues.push("page_files_not_resolved");
    if (pageResolutionCoverage > 0 && pageResolutionCoverage < 100) blockingIssues.push("partial_page_resolution");
    if (wrapperCoverage === 0 && patchCoverage === 0) blockingIssues.push("missing_wrapper_or_patch_integration");
    if (lifecycleCoverage === 0) blockingIssues.push("missing_lifecycle_sampling");
    if (routeCoverage === 0 && networkCoverage === 0) blockingIssues.push("missing_route_or_network_signal_hint");

    const recommendedActions = [
      ...(appEntry ? [] : ["Expose the actual Miniapp app entry before runtime verification."]),
      ...(pageMap.length > 0 && existingPageFiles.length === 0 ? ["Align app.json page declarations with real page source paths or sourceRoot layout."] : []),
      ...(wrapperCoverage === 0 ? ["Prefer wrapApp/wrapPage/wrapComponent as the main Miniapp integration path."] : []),
      ...(patchCoverage === 0 ? ["Enable runtime patch only as enhancement, not as the only evidence source."] : []),
      ...(lifecycleCoverage === 0 ? ["Expose lifecycle hooks so continuity can be proven."] : []),
      ...(routeCoverage === 0 && networkCoverage === 0 ? ["Capture at least route or network signals before closure decisions."] : []),
      ...(pageResolutionCoverage > 0 && pageResolutionCoverage < 100 ? ["Resolve remaining declared pages under the active Miniapp source root before trusting verify results."] : []),
    ];

    return {
      root,
      projectConfigEntry: resolution.projectConfigEntry ? toRelative(this.projectRoot, resolution.projectConfigEntry) : "",
      sourceRoot: resolution.sourceRoot || (path.relative(this.projectRoot, root) || "."),
      workspaceRoot: this.projectRoot,
      appEntry,
      entries: uniq([
        appEntry ? path.join(path.relative(this.projectRoot, root) || ".", appEntry).replace(/\\/g, "/") : "",
        resolution.projectConfigEntry ? toRelative(this.projectRoot, resolution.projectConfigEntry) : "",
      ].filter(Boolean)),
      pageMap: uniq(pageMap),
      resolvedPageFiles: existingPageFiles,
      subPackages: uniq(subPackages),
      pageRegistrationResolution,
      structureAmbiguities,
      componentFiles,
      wrapperCoverage,
      patchCoverage,
      routeCoverage,
      lifecycleCoverage,
      networkCoverage,
      pageResolutionCoverage,
      blockingIssues,
      recommendedActions,
      signals,
    };
  }

  async detectTarget(target?: string): Promise<TargetDetectionReport> {
    const normalized = String(target || "").trim().toLowerCase();
    if (normalized === "backend") {
      return {
        detectedTarget: "backend",
        status: "inapplicable",
        confidence: 0.95,
        signals: [],
        blockingIssues: ["backend_auxiliary_only"],
        recommendedAction: "Use the relay together with a web or miniapp runtime target.",
        projectRoot: this.projectRoot,
        supportedTarget: null,
      };
    }

    const miniappResolution = normalized === "web" ? null : await this.resolveMiniappRoot();
    const webRoot = normalized === "miniapp" ? "" : await this.resolveWebRoot();
    const miniappAnalysis = miniappResolution ? await this.analyzeMiniapp(miniappResolution) : null;
    const webFiles = webRoot ? (await collectFiles(webRoot, 5)).map((file) => toRelative(webRoot, file)) : [];
    const webPkg = webRoot ? await readJson(path.join(webRoot, "package.json")) : {};
    const webFramework = webRoot ? frameworkFromDeps(webPkg, webFiles) : "unknown";
    const webSignals: TargetSignal[] = webRoot
      ? [
          ...(webFramework !== "unknown" ? [{ kind: "dependency" as const, value: `framework:${webFramework}`, weight: 6 }] : []),
          ...webFiles
            .filter((file) => /src\/(main|index)\.(t|j)sx?$/.test(file) || /^app\/layout\.(t|j)sx?$/.test(file) || /^pages\/_app\.(t|j)sx?$/.test(file))
            .slice(0, 4)
            .map((value) => ({ kind: "file" as const, value, weight: 4 })),
          ...webFiles
            .filter((file) => /(api|request|fetch|router|routes)/.test(file))
            .slice(0, 6)
            .map((value) => ({ kind: "code_pattern" as const, value, weight: 2 })),
        ]
      : [];
    const miniappScore = (miniappAnalysis?.signals || []).reduce((sum, signal) => sum + signal.weight, 0);
    const webScore = webSignals.reduce((sum, signal) => sum + signal.weight, 0);

    if (normalized === "miniapp" || miniappScore > webScore) {
      if (miniappAnalysis && miniappAnalysis.signals.length > 0) {
        const status = miniappAnalysis.blockingIssues.length === 0 ? "detected_supported" : "detected_partial";
        return {
          detectedTarget: "miniapp",
          status,
          confidence: Math.min(0.99, 0.45 + miniappScore / 40),
          signals: miniappAnalysis.signals,
          blockingIssues: miniappAnalysis.blockingIssues,
          recommendedAction: miniappAnalysis.recommendedActions[0] || "Run relay miniapp verify.",
          projectRoot: miniappAnalysis.root,
          supportedTarget: "miniapp",
          framework: "miniapp",
        };
      }
      return {
        detectedTarget: "unknown",
        status: "unknown_but_observable",
        confidence: 0.3,
        signals: [],
        blockingIssues: ["miniapp_signals_not_detected"],
        recommendedAction: "Point the relay at the actual Miniapp source root or provide --target miniapp explicitly.",
        projectRoot: this.projectRoot,
        supportedTarget: null,
      };
    }

    if (normalized === "web" || webScore > 0) {
      const blockingIssues: string[] = [];
      if (webFramework === "unknown") blockingIssues.push("web_framework_unclear");
      if (!webFiles.some((file) => /src\/(main|index)\.(t|j)sx?$/.test(file) || /^app\/layout\.(t|j)sx?$/.test(file) || /^pages\/_app\.(t|j)sx?$/.test(file))) {
        blockingIssues.push("missing_web_bootstrap_hint");
      }
      return {
        detectedTarget: "web",
        status: blockingIssues.length === 0 ? "detected_supported" : "detected_partial",
        confidence: Math.min(0.99, 0.4 + webScore / 35),
        signals: webSignals,
        blockingIssues,
        recommendedAction: blockingIssues.length === 0 ? "Run relay project verify --target web." : "Inspect the web entrypoint and route/network layers first.",
        projectRoot: webRoot || this.projectRoot,
        supportedTarget: "web",
        framework: webFramework,
      };
    }

    return {
      detectedTarget: "unknown",
      status: "unsupported",
      confidence: 0.2,
      signals: [],
      blockingIssues: ["unsupported_target"],
      recommendedAction: "Use the skill only for browser web projects or WeChat miniapp projects.",
      projectRoot: this.projectRoot,
      supportedTarget: null,
    };
  }

  async identify(target?: string): Promise<{ target: string; supportedTarget: SupportedTarget | null; framework: WebFramework | "miniapp"; projectRoot: string }> {
    const report = await this.detectTarget(target);
    return {
      target: report.detectedTarget,
      supportedTarget: report.supportedTarget,
      framework: (report.framework || "unknown") as WebFramework | "miniapp",
      projectRoot: report.projectRoot,
    };
  }

  async inspectWeb(): Promise<WebIntegrationReport> {
    const root = await this.resolveWebRoot();
    const pkg = await readJson(path.join(root, "package.json"));
    const files = (await collectFiles(root, 5)).map((file) => toRelative(root, file));
    const framework = frameworkFromDeps(pkg, files);
    const entrypoints: ProjectEntrypoint[] = uniq(
      files.flatMap((file) => {
        const entries: ProjectEntrypoint[] = [];
        if (/src\/(main|index)\.(t|j)sx?$/.test(file) || /^app\/layout\.(t|j)sx?$/.test(file) || /^pages\/_app\.(t|j)sx?$/.test(file)) {
          entries.push({ path: file, role: "bootstrap" });
        }
        if (/router|routes/.test(file)) entries.push({ path: file, role: "route" });
        if (/(api|request|fetch|http)\.(t|j)sx?$/.test(path.basename(file))) entries.push({ path: file, role: "network" });
        if (/error|boundary/i.test(path.basename(file))) entries.push({ path: file, role: "error-boundary" });
        return entries;
      }).map((entry) => `${entry.path}:${entry.role}`)
    ).map((encoded) => {
      const [entryPath, role] = encoded.split(":");
      return { path: entryPath, role: role as ProjectEntrypoint["role"] };
    });
    const routeMode =
      framework === "nextjs"
        ? files.some((file) => file.startsWith("app/"))
          ? "next-app-router"
          : "next-pages-router"
        : framework === "taro-h5"
          ? "taro-pages"
          : framework === "uniapp-h5"
            ? "uni-pages"
            : files.some((file) => /vue-router/.test(file))
              ? "vue-router-like"
              : files.some((file) => /react-router|router/.test(file))
                ? "react-router-like"
                : "unknown";
    const networkLayerCandidates = entrypoints.filter((item) => item.role === "network").map((item) => item.path);
    const errorBoundaryCandidates = entrypoints.filter((item) => item.role === "error-boundary").map((item) => item.path);
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
        ...(entrypoints.some((item) => item.role === "bootstrap") ? [] : ["Identify the real client bootstrap entry before relay injection."]),
        ...(routeMode === "unknown" ? ["Attach route instrumentation at the router or top-level navigation layer."] : []),
        ...(networkLayerCandidates.length > 0 ? [] : ["Instrument fetch/XHR or the shared request wrapper before runtime verification."]),
        ...(errorBoundaryCandidates.length > 0 ? [] : ["Expose an error boundary or top-level runtime error surface for the relay."]),
      ],
    };
  }

  async resolveProject(target?: string): Promise<ProjectResolutionReport> {
    const detected = await this.detectTarget(target);
    const topology = await this.resolveWorkspaceTopology();
    if (detected.supportedTarget === "miniapp") {
      const miniapp = await this.inspectMiniapp();
      const recognized = [
        miniapp.projectConfigEntry || "",
        miniapp.sourceRoot ? `sourceRoot:${miniapp.sourceRoot}` : "",
        miniapp.appEntry ? `app:${miniapp.appEntry}` : "",
        ...(miniapp.pageMap || []).slice(0, 10).map((page) => `page:${page}`),
      ].filter(Boolean);
      const notRecognized = [
        ...(miniapp.appEntry ? [] : ["app_entry"]),
        ...((miniapp.pageMap || []).length > 0 ? [] : ["page_registrations"]),
        ...(miniapp.pageRegistrationResolution === "resolved" ? [] : ["full_page_resolution"]),
      ];
      return {
        target: "miniapp",
        status: detected.status,
        confidence: detected.confidence,
        framework: "miniapp",
        workspaceRoot: this.projectRoot,
        resolvedProjectRoot: miniapp.resolvedMiniappRoot || ".",
        sourceRoot: miniapp.sourceRoot,
        entrypoints: [
          ...(miniapp.appEntry ? [{ path: miniapp.appEntry, role: "app" as const }] : []),
          ...(miniapp.resolvedPageFiles || []).slice(0, 10).map((file) => ({ path: file, role: "page" as const })),
        ],
        routeLayerCandidates: miniapp.routeCoverage > 0 ? ["miniapp-route-wrapper"] : [],
        networkLayerCandidates: miniapp.networkCoverage > 0 ? ["wx.request-wrapper"] : [],
        errorBoundaryCandidates: [],
        pageRegistrations: miniapp.pageMap || [],
        packageTopology: {
          monorepo: topology.monorepo,
          apps: topology.apps,
          packages: topology.packages,
        },
        blockingIssues: miniapp.blockingIssues,
        recommendedActions: miniapp.recommendedActions,
        recognized,
        notRecognized,
        blindSpots: miniapp.structureAmbiguities || [],
      };
    }

    if (detected.supportedTarget === "web") {
      const web = await this.inspectWeb();
      return {
        target: "web",
        status: detected.status,
        confidence: detected.confidence,
        framework: web.framework,
        workspaceRoot: this.projectRoot,
        resolvedProjectRoot: await this.resolveWebRoot(),
        entrypoints: web.entrypoints,
        routeLayerCandidates: web.entrypoints.filter((item) => item.role === "route").map((item) => item.path),
        networkLayerCandidates: web.networkLayerCandidates,
        errorBoundaryCandidates: web.errorBoundaryCandidates,
        pageRegistrations: [],
        packageTopology: {
          monorepo: topology.monorepo,
          apps: topology.apps,
          packages: topology.packages,
        },
        blockingIssues: web.blockingIssues,
        recommendedActions: web.recommendedActions,
        recognized: [
          `framework:${web.framework}`,
          ...web.entrypoints.map((item) => `${item.role}:${item.path}`),
        ],
        notRecognized: [
          ...(web.entrypoints.some((item) => item.role === "bootstrap") ? [] : ["bootstrap_entry"]),
          ...(web.routeMode === "unknown" ? ["route_layer"] : []),
          ...(web.networkLayerCandidates.length > 0 ? [] : ["network_layer"]),
        ],
        blindSpots: [
          ...(topology.monorepo ? ["workspace_root_may_require_explicit_subapp_selection"] : []),
          ...(web.framework === "unknown" ? ["framework_not_confidently_identified"] : []),
        ],
      };
    }

    return {
      target: detected.detectedTarget,
      status: detected.status,
      confidence: detected.confidence,
      framework: detected.framework,
      workspaceRoot: this.projectRoot,
      resolvedProjectRoot: detected.projectRoot,
      entrypoints: [],
      routeLayerCandidates: [],
      networkLayerCandidates: [],
      errorBoundaryCandidates: [],
      pageRegistrations: [],
      packageTopology: {
        monorepo: topology.monorepo,
        apps: topology.apps,
        packages: topology.packages,
      },
      blockingIssues: detected.blockingIssues,
      recommendedActions: [detected.recommendedAction],
      recognized: detected.signals.map((signal) => `${signal.kind}:${signal.value}`),
      notRecognized: ["runtime_target"],
      blindSpots: ["project_not_resolved_to_supported_target"],
    };
  }

  async inspectMiniapp(): Promise<MiniappProjectIntegrationReport> {
    const resolution = await this.resolveMiniappRoot();
    const analysis = await this.analyzeMiniapp(resolution);
    return {
      target: "miniapp",
      status: analysis.blockingIssues.length === 0 ? "supported" : analysis.appEntry || analysis.pageResolutionCoverage > 0 ? "partial" : "unsupported",
      structureStatus: analysis.blockingIssues.some((item) => item === "missing_page_registration" || item === "page_files_not_resolved") ? "partial" : analysis.appEntry ? "complete" : "missing",
      workspaceRoot: analysis.workspaceRoot,
      appEntry: analysis.appEntry,
      projectConfigEntry: analysis.projectConfigEntry,
      sourceRoot: analysis.sourceRoot,
      resolvedMiniappRoot: path.relative(this.projectRoot, analysis.root) || ".",
      entries: analysis.entries,
      pageCoverage: analysis.pageResolutionCoverage,
      pageResolutionCoverage: analysis.pageResolutionCoverage,
      pageMap: analysis.pageMap,
      resolvedPageFiles: analysis.resolvedPageFiles,
      subPackages: analysis.subPackages,
      componentCoverage: analysis.componentFiles.length > 0 ? 100 : 0,
      wrapperCoverage: analysis.wrapperCoverage,
      patchCoverage: analysis.patchCoverage,
      routeCoverage: analysis.routeCoverage,
      lifecycleCoverage: analysis.lifecycleCoverage,
      networkCoverage: analysis.networkCoverage,
      pageRegistrationResolution: analysis.pageRegistrationResolution,
      structureAmbiguities: analysis.structureAmbiguities,
      blockingIssues: analysis.blockingIssues,
      recommendedActions: analysis.recommendedActions,
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
      scenarioCapabilities: args.target === "web" ? ["driver_scenario", "state_templates"] : ["observe_scenario", "continuity_templates"],
      supportedEvidenceLayers: ["project_structure", "instrumentation_attached", "runtime_events_observed"],
      knownBaselines: [],
      knownFailurePatterns: [],
      lastVerifiedAt: new Date().toISOString(),
    };
  }
}

export function supportToProjectStatus(report: TargetCapabilityReport): "supported" | "partial" | "unsupported" {
  return report.status === "inapplicable" ? "unsupported" : report.status;
}
