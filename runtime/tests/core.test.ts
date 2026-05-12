import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { buildFingerprint } from "../src/core/fingerprint.js";
import { RelayEngine } from "../src/core/relay-engine.js";
import { createRelayServer } from "../src/server/app.js";
import { createWebRelay } from "../src/adapters/web.js";
import { createMiniappRelay } from "../src/adapters/miniapp.js";
import { createBackendRelay } from "../src/adapters/backend.js";
import { runCli } from "../src/cli.js";
import type { RelayConfig } from "../src/config.js";

const artifactDir = await mkdtemp(path.join(os.tmpdir(), "dev-log-relay-artifacts-"));

const config: RelayConfig = {
  port: 5077,
  host: "127.0.0.1",
  maxBufferedEvents: 1000,
  maxPendingEvents: 100,
  contextWindowSize: 5,
  includeDebug: true,
  artifactDir,
  projectMemoryDir: path.join(artifactDir, "project-memory"),
};

async function createMiniappProjectFixture() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-log-relay-miniapp-closure-"));
  await writeFile(path.join(tempDir, "project.config.json"), JSON.stringify({ miniprogramRoot: "src/miniprogram" }), "utf8");
  await mkdir(path.join(tempDir, "src/miniprogram/pages/home"), { recursive: true });
  await writeFile(
    path.join(tempDir, "src/miniprogram/app.json"),
    JSON.stringify({
      pages: ["pages/home/index"],
    }),
    "utf8"
  );
  await writeFile(path.join(tempDir, "src/miniprogram/app.ts"), "App({})\n", "utf8");
  await writeFile(
    path.join(tempDir, "src/miniprogram/pages/home/index.ts"),
    "Page({ onLoad() { wx.request({ url: '/home' }) } })\n",
    "utf8"
  );
  return tempDir;
}

test("fingerprint remains stable for dynamic ids", () => {
  const a = buildFingerprint({
    source: "miniapp",
    level: "error",
    route: "/pages/index",
    message: "请求失败 userId=123456",
    stack: "Error: network\nat fetch (app.js:10:2)",
    phase: "network",
  });
  const b = buildFingerprint({
    source: "miniapp",
    level: "error",
    route: "/pages/index",
    message: "请求失败 userId=789999",
    stack: "Error: network\nat fetch (app.js:10:2)",
    phase: "network",
  });
  assert.equal(a, b);
});

test("relay engine supports diagnosis, integrity, closure, and artifact generation", async () => {
  const engine = new RelayEngine(config);
  const { run, session } = engine.startOrchestration({
    label: "web smoke",
    target: "web",
    scenario: "smoke",
  });
  assert.equal(session.runId, run.id);
  const step = engine.startStep(run.id, { name: "click save", kind: "action", route: "/quests" });
  assert.ok(step);

  engine.ingest({
    source: "admin-web",
    level: "info",
    message: "button clicked",
    runId: run.id,
    stepId: step?.id,
    route: "/quests",
    phase: "navigation",
  });
  engine.ingest({
    source: "admin-web",
    level: "warn",
    message: "request failed",
    runId: run.id,
    stepId: step?.id,
    route: "/quests",
    phase: "network",
    network: { url: "/api/save", method: "POST", statusCode: 500, ok: false, stage: "fail" },
    stack: "Error: request failed\nat submit (app.js:1)",
  });
  engine.ingest({
    source: "admin-web",
    level: "error",
    message: "save failed requestId=12345",
    runId: run.id,
    stepId: step?.id,
    route: "/quests",
    stack: "Error: save failed\nat submit (app.js:1)",
  });
  engine.addCheckpoint(run.id, { name: "after-click", stepId: step?.id });
  engine.endStep(run.id, step!.id, { status: "failed" });
  engine.endRun(run.id, { status: "failed" });

  const diagnosis = engine.listRunDiagnosis(run.id);
  assert.ok(diagnosis);
  assert.equal(diagnosis?.dominantFailureStep?.id, step?.id);
  assert.ok(diagnosis?.suspectedRootCauses.length);

  const integrity = engine.listRunIntegrity(run.id);
  assert.equal(integrity.hasStepBoundaries, true);
  assert.equal(integrity.hasNetworkSignals, true);
  assert.equal(integrity.hasRouteSignals, true);

  const closure = engine.listRunClosure(run.id);
  assert.ok(closure);
  assert.equal(closure?.decision.status, "unresolved");

  const artifact = await engine.getRunArtifact(run.id, "engine-artifact.json");
  assert.ok(artifact.filePath.endsWith("engine-artifact.json"));
  const parsed = JSON.parse(await readFile(artifact.filePath, "utf8"));
  assert.equal(parsed.run.id, run.id);
  assert.equal(parsed.checkpoints.length, 1);
});

test("windowed incidents count only events inside the requested window", () => {
  const engine = new RelayEngine(config);
  const oldTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  engine.ingest({
    source: "backend",
    level: "error",
    message: "old failure",
    timestamp: oldTs,
  });
  engine.ingest({
    source: "backend",
    level: "error",
    message: "fresh failure",
  });
  const snapshot = engine.listIncidents(15, 10);
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.incidents[0].count, 1);
});

test("diffRuns classifies resolved and new incidents", () => {
  const engine = new RelayEngine(config);
  const run1 = engine.startRun({ label: "baseline", target: "web" });
  const step1 = engine.startStep(run1.id, { name: "save", kind: "action" });
  engine.ingest({
    source: "admin-web",
    level: "error",
    message: "save failed",
    runId: run1.id,
    stepId: step1?.id,
    stack: "Error: save failed",
  });
  engine.endStep(run1.id, step1!.id, { status: "failed" });
  engine.endRun(run1.id, { status: "failed" });

  const { run: run2 } = engine.startOrchestration({ label: "after fix", target: "web", baselineRunId: run1.id });
  const step2 = engine.startStep(run2.id, { name: "save", kind: "action" });
  engine.ingest({
    source: "admin-web",
    level: "error",
    message: "permission denied",
    runId: run2.id,
    stepId: step2?.id,
    stack: "Error: permission denied",
  });
  engine.endStep(run2.id, step2!.id, { status: "failed" });
  engine.endRun(run2.id, { status: "failed" });

  const diff = engine.diffRuns(run1.id, run2.id);
  assert.equal(diff.changed.length, 2);
  assert.ok(diff.changed.some((item) => item.status === "resolved"));
  assert.ok(diff.changed.some((item) => item.status === "new"));
  const closure = engine.listRunClosure(run2.id);
  assert.equal(closure?.decision.status, "unresolved");
});

test("late events are accepted but marked after run end", () => {
  const engine = new RelayEngine(config);
  const run = engine.startRun({ label: "late event run", target: "miniapp" });
  engine.endRun(run.id, { status: "passed" });
  const result = engine.ingest({
    source: "miniapp",
    level: "warn",
    message: "async follow-up",
    runId: run.id,
  });
  assert.equal(result.accepted, true);
  const timeline = engine.listRunTimeline(run.id, { level: "debug", limit: 20 });
  const late = timeline.find((item) => item.type !== "step_boundary");
  assert.ok(late && "event" in late && late.event.lateEvent);
});

test("server exposes orchestration, diagnosis, closure, integrity, report, and artifact endpoints", async () => {
  const server = createRelayServer(config);
  const orchestration = await server.inject({
    method: "POST",
    url: "/orchestrations/start",
    payload: { label: "api run", target: "web", scenario: "smoke" },
  });
  assert.equal(orchestration.statusCode, 200);
  const runId = orchestration.json().runId as string;

  const startStep = await server.inject({
    method: "POST",
    url: `/runs/${runId}/steps/start`,
    payload: { name: "navigate", kind: "navigate", route: "/dashboard" },
  });
  const stepId = startStep.json().stepId as string;

  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: {
      source: "admin-web",
      level: "error",
      message: "boom",
      runId,
      stepId,
      route: "/dashboard",
    },
  });
  await server.inject({
    method: "POST",
    url: `/runs/${runId}/steps/${stepId}/end`,
    payload: { status: "failed" },
  });
  await server.inject({
    method: "POST",
    url: `/runs/${runId}/end`,
    payload: { status: "failed" },
  });

  const diagnosis = await server.inject({ method: "GET", url: `/ai/run/${runId}/diagnosis` });
  assert.equal(diagnosis.statusCode, 200);
  assert.equal(diagnosis.json().diagnosis.runId, runId);

  const closure = await server.inject({ method: "GET", url: `/ai/run/${runId}/closure` });
  assert.equal(closure.statusCode, 200);

  const integrity = await server.inject({ method: "GET", url: `/ai/run/${runId}/integrity` });
  assert.equal(integrity.statusCode, 200);

  const report = await server.inject({ method: "GET", url: `/ai/run/${runId}/report` });
  assert.equal(report.statusCode, 200);
  assert.equal(report.json().report.runId, runId);

  const artifact = await server.inject({ method: "GET", url: `/ai/run/${runId}/artifact?path=server-artifact.json` });
  assert.equal(artifact.statusCode, 200);
  assert.ok(String(artifact.json().filePath).endsWith("server-artifact.json"));

  await server.close();
});

test("server exposes autoloop, collection, repair brief, and decision endpoints", async () => {
  const server = createRelayServer(config);
  const started = await server.inject({
    method: "POST",
    url: "/autoloops/start",
    payload: { triggerReason: "runtime_error", target: "web", scenario: "broken" },
  });
  assert.equal(started.statusCode, 200);
  const autoloopId = started.json().autoloopId as string;
  const runId = started.json().runId as string;

  const attempt = await server.inject({
    method: "POST",
    url: `/autoloops/${autoloopId}/attempts/start`,
    payload: { currentRunId: runId },
  });
  assert.equal(attempt.statusCode, 200);
  const attemptId = attempt.json().attempt.id as string;

  const step = await server.inject({
    method: "POST",
    url: `/runs/${runId}/steps/start`,
    payload: { name: "trigger failure", kind: "action", route: "/broken" },
  });
  const stepId = step.json().stepId as string;

  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: {
      source: "admin-web",
      level: "warn",
      message: "request failed",
      runId,
      stepId,
      phase: "network",
      route: "/broken",
    },
  });
  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: {
      source: "admin-web",
      level: "error",
      message: "ui failed",
      runId,
      stepId,
      route: "/broken",
    },
  });
  await server.inject({ method: "POST", url: `/runs/${runId}/steps/${stepId}/end`, payload: { status: "failed" } });
  await server.inject({ method: "POST", url: `/runs/${runId}/end`, payload: { status: "failed" } });

  const collection = await server.inject({ method: "GET", url: `/ai/run/${runId}/collection` });
  assert.equal(collection.statusCode, 200);
  assert.equal(collection.json().collection.runId, runId);

  const brief = await server.inject({ method: "GET", url: `/ai/run/${runId}/repair-brief` });
  assert.equal(brief.statusCode, 200);
  assert.ok(Array.isArray(brief.json().repairBrief.successCriteria));

  const repair = await server.inject({
    method: "POST",
    url: `/autoloops/${autoloopId}/attempts/${attemptId}/repair-outcome`,
    payload: { changedFiles: ["src/demo.ts"], riskLevel: "medium", notes: "demo" },
  });
  assert.equal(repair.statusCode, 200);

  const decision = await server.inject({ method: "GET", url: `/ai/autoloop/${autoloopId}/decision` });
  assert.equal(decision.statusCode, 200);
  assert.ok(typeof decision.json().decision.shouldContinue === "boolean");

  const support = await server.inject({ method: "GET", url: "/ai/targets/support?target=miniapp" });
  assert.equal(support.statusCode, 200);
  assert.equal(support.json().report.status, "partial");

  const guide = await server.inject({ method: "GET", url: "/ai/web/integration-guide" });
  assert.equal(guide.statusCode, 200);
  assert.equal(guide.json().guide.evidenceSource, "runtime_relay");

  const trigger = await server.inject({
    method: "POST",
    url: "/ai/trigger/decision",
    payload: { target: "web", reason: "测试整体流程", phase: "self_test", runtimeImpact: true },
  });
  assert.equal(trigger.statusCode, 200);
  assert.equal(trigger.json().decision.mustTrigger, true);

  const enforcement = await server.inject({
    method: "POST",
    url: "/ai/task/enforcement",
    payload: { target: "web", phase: "self_test", runtimeImpact: true, runId, closureClaim: true },
  });
  assert.equal(enforcement.statusCode, 200);
  assert.equal(enforcement.json().enforcement.mustUseSkill, true);

  const readiness = await server.inject({ method: "GET", url: `/ai/run/${runId}/readiness` });
  assert.equal(readiness.statusCode, 200);
  assert.ok(typeof readiness.json().readiness.bestPracticeCompliant === "boolean");

  await server.close();
});

test("server exposes project identify, handoff, and repair strategy endpoints", async () => {
  const server = createRelayServer(config);
  const identified = await server.inject({
    method: "POST",
    url: "/ai/project/identify",
    payload: { target: "web" },
  });
  assert.equal(identified.statusCode, 200);
  const projectId = identified.json().profile.projectId as string;

  const orchestration = await server.inject({
    method: "POST",
    url: "/orchestrations/start",
    payload: { label: "handoff run", target: "web", scenario: "broken" },
  });
  const runId = orchestration.json().runId as string;
  const step = await server.inject({
    method: "POST",
    url: `/runs/${runId}/steps/start`,
    payload: { name: "render", kind: "action", route: "/demo" },
  });
  const stepId = step.json().stepId as string;
  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: { source: "admin-web", level: "info", message: "render completed", phase: "render", tags: ["render_complete"], runId, stepId, route: "/demo" },
  });
  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: { source: "admin-web", level: "error", message: "broken", runId, stepId, route: "/demo" },
  });
  await server.inject({ method: "POST", url: `/runs/${runId}/steps/${stepId}/end`, payload: { status: "failed" } });
  await server.inject({ method: "POST", url: `/runs/${runId}/end`, payload: { status: "failed" } });

  const strategy = await server.inject({ method: "GET", url: `/ai/run/${runId}/repair-strategy` });
  assert.equal(strategy.statusCode, 200);
  assert.ok(strategy.json().repairStrategy.strategy);

  const handoff = await server.inject({ method: "GET", url: `/ai/run/${runId}/handoff` });
  assert.equal(handoff.statusCode, 200);
  assert.equal(handoff.json().handoff.run.id, runId);

  const history = await server.inject({ method: "GET", url: `/ai/project/history?projectId=${encodeURIComponent(projectId)}` });
  assert.equal(history.statusCode, 200);

  const contract = await server.inject({ method: "GET", url: "/ai/driver/contract?target=web&driver=computer-use" });
  assert.equal(contract.statusCode, 200);
  assert.equal(contract.json().contract.driver, "computer-use");

  await server.close();
});

test("cli can call diagnosis and compare flows", async () => {
  const outputs: string[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body =
      url.endsWith("/diagnosis")
        ? { ok: true, diagnosis: { runId: "run-1", dominantFailureStep: null, missingSignals: [], suspectedRootCauses: [] } }
        : url.endsWith("/report")
          ? { ok: true, report: { runId: "run-1", verdict: { status: "resolved" } } }
        : url.includes("/ai/diff")
          ? { ok: true, changed: [{ fingerprint: "abc", status: "resolved" }] }
          : url.endsWith("/closure")
            ? { ok: true, closure: { decision: { status: "resolved" } } }
            : { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  const code1 = await runCli(["ai", "diagnosis", "--runId", "run-1"], {
    fetchImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(code1, 0);
  assert.ok(outputs.join("").includes("run-1"));
  outputs.length = 0;

  const codeReport = await runCli(["ai", "report", "--runId", "run-1"], {
    fetchImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(codeReport, 0);
  assert.ok(outputs.join("").includes("\"report\""));

  const code2 = await runCli(["loop", "compare", "--baselineRunId", "a", "--currentRunId", "b"], {
    fetchImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(code2, 0);
});

test("cli can run autoloop and miniapp verify flows", async () => {
  const outputs: string[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    let body: Record<string, unknown> = { ok: true };
    if (url.includes("/ai/targets/support")) {
      body = url.includes("miniapp")
        ? { ok: true, report: { target: "miniapp", status: "partial", reasonCode: "miniapp_verify_required", reason: "verify first", recommendedAction: "relay miniapp verify", supportedTargets: ["web", "miniapp"], currentCapabilities: ["miniapp-sdk"] } }
        : { ok: true, report: { target: "web", status: "supported", reasonCode: "web_supported", reason: "supported", recommendedAction: "relay autoloop run --target web", supportedTargets: ["web", "miniapp"], currentCapabilities: ["playwright-driver"], recommendedIntegrationMode: "browser-injected", evidenceSource: "runtime_relay" } };
    } else if (url.endsWith("/ai/project/identify") && method === "POST") {
      const requestBody = JSON.parse(String(init?.body || "{}"));
      body = {
        ok: true,
        profile: {
          projectId: `${requestBody.target || "web"}-project`,
          projectRoot: "/tmp/project",
          target: requestBody.target || "web",
          framework: requestBody.target === "miniapp" ? "miniapp" : "react-vite",
          integrationMode: requestBody.target === "miniapp" ? "wrapper-first" : "browser-injected",
          knownEntrypoints: ["src/main.tsx"],
          knownSignalGaps: [],
          lastVerifiedAt: new Date().toISOString(),
        },
      };
    } else if (url.endsWith("/ai/web/project-check")) {
      body = {
        ok: true,
        report: {
          target: "web",
          framework: "react-vite",
          entrypoints: [{ path: "src/main.tsx", role: "bootstrap" }],
          routeMode: "react-router-like",
          networkLayerCandidates: ["src/api.ts"],
          errorBoundaryCandidates: ["src/App.tsx"],
          relayInsertionReadiness: "ready",
          blockingIssues: [],
          recommendedActions: [],
        },
      };
    } else if (url.endsWith("/ai/miniapp/project-check")) {
      body = {
        ok: true,
        report: {
          target: "miniapp",
          status: "partial",
          appEntry: "app.ts",
          pageCoverage: 100,
          componentCoverage: 100,
          wrapperCoverage: 100,
          patchCoverage: 100,
          routeCoverage: 100,
          lifecycleCoverage: 100,
          networkCoverage: 100,
          blockingIssues: [],
          recommendedActions: [],
        },
      };
    } else if (url.endsWith("/ai/web/integration-guide")) {
      body = { ok: true, guide: { target: "web", evidenceSource: "runtime_relay", requiredSignals: ["console", "error", "network_or_route", "render", "step_boundary"] } };
    } else if (url.endsWith("/ai/trigger/decision") && method === "POST") {
      const requestBody = JSON.parse(String(init?.body || "{}"));
      body = requestBody.target === "miniapp"
        ? { ok: true, decision: { status: "must_trigger", mustTrigger: true, reasonCode: "miniapp_verify_required", decisionReason: "verify first", recommendedCommand: "relay miniapp verify", blockingReason: "verify_required_before_repair" } }
        : { ok: true, decision: { status: "must_trigger", mustTrigger: true, reasonCode: "web_autoloop_required", decisionReason: "run autoloop", recommendedCommand: "relay autoloop run --target web", blockingReason: "closure_requires_autoloop" } };
    } else if (url.endsWith("/ai/task/enforcement") && method === "POST") {
      body = { ok: true, enforcement: { mustUseSkill: true, canClaimDone: false, blockingReasons: ["verdict:unresolved"] } };
    } else if (url.endsWith("/orchestrations/start") && method === "POST") {
      body = { ok: true, runId: "baseline-run" };
    } else if (url.endsWith("/autoloops/start") && method === "POST") {
      body = { ok: true, autoloopId: "loop-1", runId: "broken-run" };
    } else if (url.includes("/attempts/start") && method === "POST") {
      body = { ok: true, attempt: { id: url.includes("fixed-run") ? "attempt-2" : "attempt-1" } };
    } else if (url.includes("/attempts/") && url.endsWith("/repair-outcome") && method === "POST") {
      body = { ok: true, repairOutcome: { changedFiles: ["demo"] } };
    } else if (url.includes("/attempts/") && url.endsWith("/complete") && method === "POST") {
      body = { ok: true, attempt: { id: "attempt-1" }, decision: { status: "escalated", shouldContinue: true } };
    } else if (url.endsWith("/collection")) {
      body = { ok: true, collection: { runId: "broken-run", status: "complete", signalGaps: [] } };
    } else if (url.endsWith("/summary")) {
      body = { ok: true, summary: { runId: "broken-run", errorCount: 1, incidentCount: 1 } };
    } else if (url.endsWith("/diagnosis")) {
      body = { ok: true, diagnosis: { runId: "broken-run", dominantFailureStep: null, missingSignals: [], suspectedRootCauses: [], topIncidents: [] } };
    } else if (url.endsWith("/closure")) {
      body = url.includes("fixed-run")
        ? { ok: true, closure: { decision: { status: "resolved" }, evidence: [], confidence: 0.9 } }
        : { ok: true, closure: { decision: { status: "unresolved" }, evidence: [], confidence: 0.8 } };
    } else if (url.endsWith("/integrity")) {
      body = { ok: true, integrity: { runId: "broken-run", integrityScore: 90, warnings: [] } };
    } else if (url.endsWith("/scenario")) {
      body = {
        ok: true,
        scenario: {
          runId: url.includes("fixed-run") ? "fixed-run" : "broken-run",
          scenarioId: "request_to_ui_continuity",
          status: url.includes("fixed-run") ? "passed" : "partially_observed",
        },
      };
    } else if (url.endsWith("/baseline")) {
      body = {
        ok: true,
        baseline: {
          runId: url.includes("fixed-run") ? "fixed-run" : "broken-run",
          scenarioId: "request_to_ui_continuity",
          evidenceLayer: url.includes("fixed-run") ? "user_flow_closed" : "runtime_events_observed",
        },
      };
    } else if (url.endsWith("/repair-brief")) {
      body = { ok: true, repairBrief: { successCriteria: ["closure resolved"] } };
    } else if (url.includes("/ai/autoloop/") && url.endsWith("/decision")) {
      body = url.includes("loop-1") && outputs.join("").includes("resolved")
        ? { ok: true, decision: { status: "resolved", shouldContinue: false, nextAction: "stop", confidence: 0.9, evidence: [] } }
        : { ok: true, decision: { status: "escalated", shouldContinue: true, nextAction: "repair_and_retest", confidence: 0.7, evidence: [] } };
    } else if (url.includes("/ai/autoloop/")) {
      body = { ok: true, autoloop: { session: { id: "loop-1" }, attempts: [], decision: { status: "resolved" } } };
    } else if (url.includes("/ai/diff/scenario")) {
      body = { ok: true, baselineFound: true, currentFound: true, changed: [{ kind: "state", key: "request_done->ui_updated", status: "added" }] };
    } else if (url.includes("/ai/diff/state")) {
      body = { ok: true, changed: [{ transition: "request_done->ui_updated", status: "added" }] };
    } else if (url.includes("/ai/diff")) {
      body = { ok: true, changed: [{ fingerprint: "abc", status: "resolved" }] };
    } else if (url.endsWith("/report")) {
      body = { ok: true, report: { runId: url.includes("fixed-run") ? "fixed-run" : "broken-run", verdict: { status: url.includes("fixed-run") ? "resolved" : "unresolved" } } };
    } else if (url.endsWith("/artifact")) {
      body = { ok: true, artifact: { run: { id: "fixed-run" } }, filePath: "/tmp/artifact.json" };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const spawnImpl = ((_: string, args: readonly string[]) => {
    const runIdIndex = args.indexOf("--runId");
    if (runIdIndex >= 0) {
      outputs.push(`spawn:${String(args[runIdIndex + 1])}`);
    }
    const modeIndex = args.indexOf("--mode");
    if (modeIndex >= 0 && args[modeIndex + 1] === "fixed") {
      outputs.push("resolved");
    }
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  }) as any;

  const code1 = await runCli(["autoloop", "run", "--target", "web"], {
    fetchImpl,
    spawnImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(code1, 0);
  assert.ok(outputs.join("").includes("loop-1"));

  const code2 = await runCli(["miniapp", "verify"], {
    fetchImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(code2, 0);
  assert.ok(outputs.join("").includes("integration"));
  assert.ok(outputs.join("").includes("integration_required"));
});

test("cli doctor commands and unsupported autoloop target converge to structured failures", async () => {
  const outputs: string[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/ai/targets/support")) {
      const report = url.includes("backend")
        ? { target: "backend", status: "inapplicable", reasonCode: "backend_auxiliary_only", reason: "backend is auxiliary only", recommendedAction: "Use web or miniapp target.", supportedTargets: ["web", "miniapp"], currentCapabilities: ["manual-send"], recommendedIntegrationMode: "manual-fallback", evidenceSource: "runtime_relay" }
        : { target: "web", status: "supported", reasonCode: "web_supported", reason: "supported", recommendedAction: "relay autoloop run --target web", supportedTargets: ["web", "miniapp"], currentCapabilities: ["playwright-driver"], recommendedIntegrationMode: "browser-injected", evidenceSource: "runtime_relay" };
      return new Response(JSON.stringify({ ok: true, report }), { status: 200 });
    }
    if (url.endsWith("/ai/web/integration-guide")) {
      return new Response(JSON.stringify({ ok: true, guide: { target: "web", evidenceSource: "runtime_relay", requiredSignals: ["console", "error", "network_or_route", "render", "step_boundary"] } }), { status: 200 });
    }
    if (url.endsWith("/ai/trigger/decision")) {
      return new Response(
        JSON.stringify({
          ok: true,
          decision: {
            target: "web",
            phase: "self_test",
            reason: "测试流程",
            runtimeImpact: true,
            mustTrigger: true,
            status: "must_trigger",
            reasonCode: "web_autoloop_required",
            decisionReason: "run autoloop",
            recommendedCommand: "relay autoloop run --target web",
            blockingReason: "closure_requires_autoloop",
          },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const code1 = await runCli(["doctor", "target", "--target", "backend"], {
    fetchImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(code1, 0);
  assert.ok(outputs.join("").includes("backend_auxiliary_only"));

  const code2 = await runCli(["doctor", "trigger", "--target", "web", "--phase", "self_test", "--reason", "测试流程", "--runtimeImpact", "true"], {
    fetchImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(code2, 0);
  assert.ok(outputs.join("").includes("web_autoloop_required"));

  const code3 = await runCli(["autoloop", "run", "--target", "miniapp"], {
    fetchImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(code3, 1);
  assert.ok(outputs.join("").includes("unsupported_target"));
});

test("cli project verify rejects unsupported auto-detected backend repos", async () => {
  const outputs: string[] = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-log-relay-backend-"));
  await writeFile(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      name: "backend-only",
      dependencies: { express: "^5.0.0" },
    }),
    "utf8"
  );
  const previousCwd = process.cwd();
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/ai/targets/support?target=unknown")) {
      return new Response(
        JSON.stringify({
          ok: true,
          report: {
            target: "unknown",
            status: "unsupported",
            reasonCode: "unsupported_target",
            reason: "unsupported",
            recommendedAction: "Use the skill only for browser web projects or WeChat miniapp projects.",
            supportedTargets: ["web", "miniapp"],
            currentCapabilities: [],
            recommendedIntegrationMode: "manual-fallback",
            evidenceSource: "runtime_relay",
          },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    process.chdir(tempDir);
    const code = await runCli(["project", "verify", "--target", "auto"], {
      fetchImpl,
      stdout: (text) => outputs.push(text),
      stderr: (text) => outputs.push(text),
    });
    assert.equal(code, 1);
    assert.ok(outputs.join("").includes("unsupported_target"));
  } finally {
    process.chdir(previousCwd);
  }
});

test("cli can return external agent driver contract", async () => {
  const outputs: string[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/ai/driver/contract")) {
      return new Response(
        JSON.stringify({
          ok: true,
          contract: {
            target: "web",
            driver: "computer-use",
            positioning: "external_agent_driver",
            requiredOrder: ["project verify", "start run", "bind relay"],
            requiredApiCalls: ["POST /orchestrations/start"],
            requiredSignals: ["console", "render"],
            sdkBindingContract: { mustBindRun: true, mustBindStep: true, preferredAdapters: ["createWebRelay"] },
            closureContract: { mustCheckCollection: true, mustCheckClosure: true, mustCheckHandoffOnFailure: true },
            stopConditions: ["closure resolved"],
            forbiddenClaims: ["Do not claim verified before closure."],
          },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const code = await runCli(["agent", "contract", "--target", "web", "--driver", "computer-use"], {
    fetchImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(code, 0);
  assert.ok(outputs.join("").includes("computer-use"));
});

test("web verify separates project inspection from runtime-verified readiness", async () => {
  const outputs: string[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/ai/targets/support")) {
      return new Response(
        JSON.stringify({
          ok: true,
          report: {
            target: "web",
            status: "supported",
            reasonCode: "web_supported",
            reason: "supported",
            recommendedAction: "relay autoloop run --target web",
            supportedTargets: ["web", "miniapp"],
            currentCapabilities: ["playwright-driver"],
            recommendedIntegrationMode: "browser-injected",
            evidenceSource: "runtime_relay",
          },
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/ai/web/integration-guide")) {
      return new Response(
        JSON.stringify({ ok: true, guide: { target: "web", evidenceSource: "runtime_relay", requiredSignals: ["console", "error", "network_or_route", "render", "step_boundary"] } }),
        { status: 200 }
      );
    }
    if (url.endsWith("/ai/web/project-check")) {
      return new Response(
        JSON.stringify({
          ok: true,
          report: {
            target: "web",
            framework: "react-vite",
            entrypoints: [{ path: "src/main.tsx", role: "bootstrap" }],
            routeMode: "react-router-like",
            networkLayerCandidates: ["src/api.ts"],
            errorBoundaryCandidates: ["src/error-boundary.tsx"],
            relayInsertionReadiness: "ready",
            blockingIssues: [],
            recommendedActions: [],
          },
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/ai/run/run-1/readiness")) {
      return new Response(
        JSON.stringify({
          ok: true,
          readiness: {
            target: "web",
            maturity: "strong",
            evidenceSource: "runtime_relay",
            evidenceLevel: "runtime_verified",
            requiredSignals: ["console", "error", "network_or_route", "render", "step_boundary"],
            availableSignals: ["console", "error", "network", "route", "render", "step_boundary"],
            missingSignals: [],
            autoloopEligible: true,
            blockingReasons: [],
            recommendedIntegrationMode: "browser-injected",
            bestPracticeCompliant: true,
            verifiedRunId: "run-1",
          },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const code = await runCli(["web", "verify"], {
    fetchImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(code, 0);
  assert.ok(outputs.join("").includes("project_only"));
  outputs.length = 0;
  const runtimeCode = await runCli(["web", "verify", "--runId", "run-1"], {
    fetchImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(runtimeCode, 0);
  assert.ok(outputs.join("").includes("runtime_verified"));
  assert.ok(outputs.join("").includes("run-1"));
});

test("server exposes driver contract compliance for runs", async () => {
  const server = createRelayServer(config);
  const runStart = await server.inject({
    method: "POST",
    url: "/runs/start",
    payload: { label: "driver check", target: "web", metadata: { driver: "computer-use" } },
  });
  const runId = runStart.json().runId as string;
  const stepStart = await server.inject({
    method: "POST",
    url: `/runs/${runId}/steps/start`,
    payload: { name: "load", kind: "navigate", route: "/" },
  });
  const stepId = stepStart.json().stepId as string;
  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: { source: "admin-web", level: "info", message: "route changed", runId, stepId, route: "/", phase: "navigation" },
  });
  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: { source: "admin-web", level: "info", message: "render complete", runId, stepId, route: "/", phase: "render", tags: ["render_complete"] },
  });
  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: { source: "admin-web", level: "warn", message: "request failed", runId, stepId, route: "/", phase: "network" },
  });
  await server.inject({
    method: "POST",
    url: `/runs/${runId}/steps/${stepId}/end`,
    payload: { status: "failed" },
  });
  await server.inject({
    method: "POST",
    url: `/runs/${runId}/end`,
    payload: { status: "failed" },
  });
  const response = await server.inject({
    method: "GET",
    url: `/ai/run/${runId}/driver-check?driver=computer-use`,
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.driverCheck.compliant, true);
  assert.equal(payload.driverCheck.driver, "computer-use");
  await server.close();
});

test("engine builds closure evidence report and enforcement from runtime evidence", () => {
  const engine = new RelayEngine(config);
  const run = engine.startRun({ label: "report run", target: "web", metadata: { driver: "computer-use" } });
  const step = engine.startStep(run.id, { name: "save", kind: "action", route: "/save" });
  engine.ingest({ source: "admin-web", level: "info", message: "route changed", phase: "navigation", runId: run.id, stepId: step?.id, route: "/save" });
  engine.ingest({ source: "admin-web", level: "info", message: "render complete", phase: "render", tags: ["render_complete"], runId: run.id, stepId: step?.id, route: "/save" });
  engine.ingest({ source: "admin-web", level: "warn", message: "request failed", phase: "network", runId: run.id, stepId: step?.id, route: "/save" });
  engine.ingest({ source: "admin-web", level: "error", message: "save failed", runId: run.id, stepId: step?.id, route: "/save" });
  engine.endStep(run.id, step!.id, { status: "failed" });
  engine.endRun(run.id, { status: "failed" });

  const report = engine.getRunReport(run.id);
  assert.ok(report);
  assert.equal(report?.runtimeReadiness?.evidenceLevel, "runtime_verified");
  assert.equal(report?.verdict.status, "unresolved");

  const enforcement = engine.getTaskEnforcement({
    target: "web",
    phase: "self_test",
    runtimeImpact: true,
    runId: run.id,
    closureClaim: true,
  });
  assert.equal(enforcement.mustUseSkill, true);
  assert.equal(enforcement.canClaimDone, false);
  assert.ok(enforcement.blockingReasons.includes("verdict:unresolved"));
});

test("repair brief degrades for miniapp and unsupported targets", () => {
  const engine = new RelayEngine(config);
  const miniappRun = engine.startRun({ label: "miniapp run", target: "miniapp" });
  const miniappStep = engine.startStep(miniappRun.id, { name: "open", kind: "navigate", route: "/pages/home" });
  engine.ingest({ source: "miniapp", level: "error", message: "boom", runId: miniappRun.id, stepId: miniappStep?.id, route: "/pages/home" });
  engine.endStep(miniappRun.id, miniappStep!.id, { status: "failed" });
  engine.endRun(miniappRun.id, { status: "failed" });

  const brief = engine.getRepairBrief(miniappRun.id);
  assert.equal(brief?.repairScope, "integration_first");
  assert.equal(brief?.applicabilityStatus, "partial");
  assert.ok(brief?.blockingReasons.includes("miniapp_verify_required"));
});

test("collection, repair brief, and autoloop stop gates converge correctly", () => {
  const engine = new RelayEngine(config);
  const baseline = engine.startRun({ label: "baseline", target: "web" });
  const baselineStep = engine.startStep(baseline.id, { name: "load", kind: "navigate", route: "/" });
  engine.ingest({ source: "admin-web", level: "info", message: "loaded", runId: baseline.id, stepId: baselineStep?.id, route: "/", phase: "navigation" });
  engine.endStep(baseline.id, baselineStep!.id, { status: "passed" });
  engine.endRun(baseline.id, { status: "passed" });

  const { run, session } = engine.startAutoloop({
    triggerReason: "runtime_error",
    target: "web",
    scenario: "broken",
    baselineRunId: baseline.id,
  });
  const attempt = engine.startAutoloopAttempt(session.id, { baselineRunId: baseline.id, currentRunId: run.id });
  const step = engine.startStep(run.id, { name: "save", kind: "action", route: "/save" });
  engine.ingest({ source: "admin-web", level: "info", message: "render completed", runId: run.id, stepId: step?.id, route: "/save", phase: "render", tags: ["render_complete"] });
  engine.ingest({ source: "admin-web", level: "warn", message: "request failed", runId: run.id, stepId: step?.id, route: "/save", phase: "network" });
  engine.ingest({ source: "admin-web", level: "error", message: "save failed", runId: run.id, stepId: step?.id, route: "/save" });
  engine.endStep(run.id, step!.id, { status: "failed" });
  engine.endRun(run.id, { status: "failed" });

  const collection = engine.listRunCollection(run.id);
  assert.equal(collection?.status, "complete");
  const brief = engine.getRepairBrief(run.id);
  assert.equal(brief?.repairScope, "runtime_bug_fix");

  engine.recordRepairOutcome(session.id, attempt!.id, {
    changedFiles: ["src/save.ts"],
    assumptionDelta: ["retry path"],
    riskLevel: "medium",
    notes: "demo",
  });
  const decision = engine.getAutoloopDecision(session.id);
  assert.equal(decision?.shouldContinue, true);
});

test("web adapter auto capture sends console and network events and reports self-check", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const originalConsoleInfo = console.info;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  const originalConsoleDebug = console.debug;
  const originalFetch = (globalThis as any).fetch;
  const originalHistory = (globalThis as any).history;
  const originalLocation = (globalThis as any).location;
  const originalOnError = (globalThis as any).onerror;
  const originalUnhandled = (globalThis as any).onunhandledrejection;

  (globalThis as any).fetch = async (_url: string, init?: Record<string, unknown>) => {
    if (init?.body) {
      calls.push(JSON.parse(String(init.body)));
    }
    return { ok: true, status: 200 };
  };
  (globalThis as any).history = {
    pushState() {},
    replaceState() {},
  };
  (globalThis as any).location = { pathname: "/page" };

  const relay = createWebRelay({
    endpoint: "http://relay.test/ingest",
    routeProvider: () => "/page",
    sessionIdProvider: () => "session-1",
  });
  relay.bindRun("run-1");
  relay.bindStep("step-1");
  relay.startAutoCapture();
  console.error("kaboom");
  await (globalThis as any).fetch("/api/demo");
  const check = relay.selfCheck();
  relay.stopAutoCapture();

  assert.ok(calls.some((item) => item.runId === "run-1" && item.stepId === "step-1"));
  assert.ok(calls.some((item) => item.level === "error"));
  assert.ok(calls.some((item) => item.phase === "network"));
  assert.equal(check.runBound, true);
  assert.ok(check.capturedCapabilities.includes("fetch"));

  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
  console.debug = originalConsoleDebug;
  (globalThis as any).fetch = originalFetch;
  (globalThis as any).history = originalHistory;
  (globalThis as any).location = originalLocation;
  (globalThis as any).onerror = originalOnError;
  (globalThis as any).onunhandledrejection = originalUnhandled;
});

test("miniapp adapter supports wrappers, runtime patch, and self-check", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const originalWx = (globalThis as any).wx;
  const originalApp = (globalThis as any).App;
  const originalPage = (globalThis as any).Page;
  const originalComponent = (globalThis as any).Component;
  const originalGetCurrentPages = (globalThis as any).getCurrentPages;

  (globalThis as any).wx = {
    request(options: Record<string, any>) {
      if (options.url === "http://relay.test/ingest") {
        calls.push(options.data);
        return;
      }
      if (typeof options.success === "function") {
        options.success({ statusCode: 200 });
      }
    },
    navigateTo() {},
  };
  (globalThis as any).App = (config: Record<string, any>) => config;
  (globalThis as any).Page = (config: Record<string, any>) => config;
  (globalThis as any).Component = (config: Record<string, any>) => config;
  (globalThis as any).getCurrentPages = () => [{ route: "pages/index" }];

  const relay = createMiniappRelay({
    endpoint: "http://relay.test/ingest",
    routeProvider: () => "/pages/index",
    sessionIdProvider: () => "mini-session",
  });
  relay.bindRun("run-2");
  relay.bindStep("step-2");
  const wrappedPage = relay.wrapPage("IndexPage", {
    onLoad() {
      return "ok";
    },
  });
  wrappedPage.onLoad();
  const patch = relay.enableMiniappRuntimePatch();
  relay.capturePageLifecycle("IndexPage", "onLoad");
  relay.captureRouteSnapshot("/pages/index");
  relay.captureStateSnapshot("IndexPage", { list: [], ready: true });
  relay.startAutoCapture();
  (globalThis as any).wx.request({ url: "https://api.example.com/demo", method: "POST" });
  const check = relay.selfCheck();
  relay.stopAutoCapture();
  relay.disableMiniappRuntimePatch();

  assert.ok(calls.some((item) => item.phase === "lifecycle" && item.component === "IndexPage"));
  assert.ok(calls.some((item) => item.phase === "network"));
  assert.ok(calls.some((item) => Array.isArray(item.tags) && (item.tags as string[]).includes("state_signature")));
  assert.ok(calls.some((item) => item.phase === "navigation" && Array.isArray(item.tags) && (item.tags as string[]).includes("route_transition")));
  assert.ok(calls.some((item) => typeof item.requestId === "string"));
  assert.ok(calls.some((item) => item.runId === "run-2" && item.stepId === "step-2"));
  assert.equal(check.runBound, true);
  assert.ok(patch.appliedCapabilities.length >= 2);

  (globalThis as any).wx = originalWx;
  (globalThis as any).App = originalApp;
  (globalThis as any).Page = originalPage;
  (globalThis as any).Component = originalComponent;
  (globalThis as any).getCurrentPages = originalGetCurrentPages;
});

test("backend adapter reports binding state and self-check", () => {
  const relay = createBackendRelay({
    endpoint: "http://relay.test/ingest",
    fetchImpl: (async () => new Response("", { status: 200 })) as typeof fetch,
  });
  relay.bindRun("run-3");
  relay.bindStep("step-3");
  const state = relay.getBindingState();
  const check = relay.selfCheck();
  assert.equal(state.runId, "run-3");
  assert.equal(check.runBound, true);
});

test("project detection, scenario validation, and baseline diff work together", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-log-relay-web-project-"));
  await writeFile(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      name: "demo-web",
      dependencies: { react: "^18.0.0", vite: "^5.0.0" },
    }),
    "utf8"
  );
  await mkdir(path.join(tempDir, "src"), { recursive: true });
  await writeFile(path.join(tempDir, "src/main.tsx"), "console.log('boot')\n", "utf8");
  await writeFile(path.join(tempDir, "src/router.ts"), "export const router = {}\n", "utf8");
  await writeFile(path.join(tempDir, "src/api.ts"), "export async function load() {}\n", "utf8");

  const previousCwd = process.cwd();
  try {
    process.chdir(tempDir);
    const engine = new RelayEngine(config);
    const detection = await engine.detectTarget("auto");
    assert.equal(detection.detectedTarget, "web");
    assert.ok(detection.confidence > 0.4);

    const baselineRun = engine.startRun({ label: "baseline scenario", target: "web" });
    const baselineStep = engine.startStep(baselineRun.id, { name: "open", kind: "navigate", route: "/list" });
    engine.ingest({ source: "admin-web", level: "info", message: "route changed", phase: "navigation", runId: baselineRun.id, stepId: baselineStep?.id, route: "/list" });
    engine.ingest({ source: "admin-web", level: "info", message: "GET /api/list", phase: "network", runId: baselineRun.id, stepId: baselineStep?.id, route: "/list", network: { url: "/api/list", method: "GET", stage: "success" } });
    engine.ingest({ source: "admin-web", level: "info", message: "render_complete list", phase: "render", tags: ["render_complete"], runId: baselineRun.id, stepId: baselineStep?.id, route: "/list" });
    engine.endStep(baselineRun.id, baselineStep!.id, { status: "passed" });
    engine.endRun(baselineRun.id, { status: "passed" });
    const scenario1 = engine.validateScenario(baselineRun.id, {
      id: "request_to_ui_continuity",
      target: "web",
      entry: { route: "/list" },
      steps: [
        { id: "route", kind: "route_change", route: "/list" },
        { id: "request", kind: "wait_request_complete", eventPhase: "network" },
        { id: "render", kind: "wait_render", eventPhase: "render", match: "render_complete" },
      ],
      expectations: [],
      fallbacks: [],
      assertions: [{ id: "continuity", type: "continuity", match: "render_complete" }],
      stateTransitions: [{ from: "request_done", to: "ui_updated", evidenceMatch: "render_complete" }],
    });
    assert.equal(scenario1?.status, "passed");
    const baselineSnapshot = engine.captureBaseline(baselineRun.id);
    assert.ok(baselineSnapshot);

    const currentRun = engine.startRun({ label: "current scenario", target: "web" });
    const currentStep = engine.startStep(currentRun.id, { name: "open", kind: "navigate", route: "/list" });
    engine.ingest({ source: "admin-web", level: "info", message: "route changed", phase: "navigation", runId: currentRun.id, stepId: currentStep?.id, route: "/list" });
    engine.ingest({ source: "admin-web", level: "warn", message: "GET /api/list failed", phase: "network", runId: currentRun.id, stepId: currentStep?.id, route: "/list", network: { url: "/api/list", method: "GET", stage: "fail", ok: false } });
    engine.endStep(currentRun.id, currentStep!.id, { status: "failed" });
    engine.endRun(currentRun.id, { status: "failed" });
    const scenario2 = engine.validateScenario(currentRun.id, {
      id: "request_to_ui_continuity",
      target: "web",
      entry: { route: "/list" },
      steps: [
        { id: "route", kind: "route_change", route: "/list" },
        { id: "request", kind: "wait_request_complete", eventPhase: "network" },
        { id: "render", kind: "wait_render", eventPhase: "render", match: "render_complete" },
      ],
      expectations: [],
      fallbacks: [],
      assertions: [{ id: "continuity", type: "continuity", match: "render_complete" }],
      stateTransitions: [{ from: "request_done", to: "ui_updated", evidenceMatch: "render_complete" }],
    });
    assert.equal(scenario2?.status, "partially_observed");

    const diff = engine.diffScenarioBaselines(baselineRun.id, currentRun.id);
    assert.ok(diff.changed.some((item) => item.kind === "signal" || item.kind === "state"));
    const summary = engine.getShortHumanSummary(currentRun.id);
    assert.ok(summary?.topFindings.length);
  } finally {
    process.chdir(previousCwd);
  }
});

test("scenario validation requires request-to-render continuity in sequence", () => {
  const engine = new RelayEngine(config);
  const run = engine.startRun({ label: "ordering-check", target: "web" });
  const step = engine.startStep(run.id, { name: "load", kind: "navigate", route: "/list" });
  engine.ingest({ source: "admin-web", level: "info", message: "render_complete early", phase: "render", tags: ["render_complete"], runId: run.id, stepId: step?.id, route: "/list" });
  engine.ingest({
    source: "admin-web",
    level: "info",
    message: "GET /api/list -> 200",
    phase: "network",
    runId: run.id,
    stepId: step?.id,
    route: "/list",
    network: { url: "/api/list", method: "GET", stage: "success", ok: true },
  });
  engine.endStep(run.id, step!.id, { status: "failed" });
  engine.endRun(run.id, { status: "failed" });

  const scenario = engine.validateScenario(run.id, {
    id: "request_to_ui_continuity",
    target: "web",
    entry: { route: "/list" },
    steps: [
      { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      { id: "render", kind: "wait_render", eventPhase: "render", match: "render_complete" },
    ],
    expectations: [],
    fallbacks: [],
    assertions: [{ id: "continuity", type: "continuity", match: "render_complete" }],
    stateTransitions: [{ from: "request_done", to: "ui_updated", evidenceMatch: "render_complete" }],
  });
  assert.equal(scenario?.status, "partially_observed");
  assert.ok(scenario?.missingEvidence.includes("step:render"));
  assert.ok(scenario?.missingEvidence.includes("assertion:continuity"));
});

test("miniapp detection respects project.config source root and subpackage pages", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-log-relay-miniapp-project-"));
  await writeFile(path.join(tempDir, "project.config.json"), JSON.stringify({ miniprogramRoot: "src/miniprogram" }), "utf8");
  await mkdir(path.join(tempDir, "src/miniprogram/pages/home"), { recursive: true });
  await mkdir(path.join(tempDir, "src/miniprogram/pkgA/detail"), { recursive: true });
  await writeFile(
    path.join(tempDir, "src/miniprogram/app.json"),
    JSON.stringify({
      pages: ["pages/home/index"],
      subPackages: [{ root: "pkgA", pages: ["detail/index"] }],
    }),
    "utf8"
  );
  await writeFile(path.join(tempDir, "src/miniprogram/app.ts"), "import { wrapApp } from 'relay';\nApp(wrapApp({}))\n", "utf8");
  await writeFile(path.join(tempDir, "src/miniprogram/pages/home/index.ts"), "Page({ onLoad() {}, onShow() {} })\n", "utf8");
  await writeFile(path.join(tempDir, "src/miniprogram/pkgA/detail/index.js"), "Page({ onLoad() { wx.request({ url: '/detail' }) } })\n", "utf8");

  const previousCwd = process.cwd();
  try {
    process.chdir(tempDir);
    const engine = new RelayEngine(config);
    const detection = await engine.detectTarget("auto");
    assert.equal(detection.detectedTarget, "miniapp");
    assert.notEqual(detection.status, "unsupported");

    const report = await engine.inspectMiniappProject();
    assert.equal(report.projectConfigEntry, "project.config.json");
    assert.equal(report.sourceRoot, "src/miniprogram");
    assert.equal(report.resolvedMiniappRoot, "src/miniprogram");
    assert.equal(report.pageMap?.includes("pages/home/index"), true);
    assert.equal(report.pageMap?.includes("pkgA/detail/index"), true);
    assert.equal(report.pageResolutionCoverage, 100);
    assert.equal(report.pageCoverage, 100);
    assert.equal(report.resolvedPageFiles?.includes("pages/home/index"), true);
    assert.equal(report.resolvedPageFiles?.includes("pkgA/detail/index"), true);
  } finally {
    process.chdir(previousCwd);
  }
});

test("miniapp compatibility does not over-claim route and page coverage from declarations alone", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-log-relay-miniapp-partial-"));
  await writeFile(path.join(tempDir, "project.config.json"), JSON.stringify({ miniprogramRoot: "miniprogram" }), "utf8");
  await mkdir(path.join(tempDir, "miniprogram/pages/home"), { recursive: true });
  await writeFile(
    path.join(tempDir, "miniprogram/app.json"),
    JSON.stringify({
      pages: ["pages/home/index", "pages/missing/index"],
    }),
    "utf8"
  );
  await writeFile(path.join(tempDir, "miniprogram/app.ts"), "App({})\n", "utf8");
  await writeFile(path.join(tempDir, "miniprogram/pages/home/index.ts"), "Page({})\n", "utf8");

  const previousCwd = process.cwd();
  try {
    process.chdir(tempDir);
    const engine = new RelayEngine(config);
    const report = await engine.inspectMiniappProject();
    assert.equal(report.status, "partial");
    assert.equal(report.pageCoverage, 50);
    assert.equal(report.pageResolutionCoverage, 50);
    assert.equal(report.routeCoverage < 100, true);
    assert.ok(report.blockingIssues.includes("partial_page_resolution"));
  } finally {
    process.chdir(previousCwd);
  }
});

test("server project inspection honors request workspace root instead of server cwd", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-log-relay-header-root-"));
  await writeFile(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      name: "header-root-web",
      dependencies: { react: "^18.0.0", vite: "^5.0.0" },
    }),
    "utf8"
  );
  await mkdir(path.join(tempDir, "src"), { recursive: true });
  await writeFile(path.join(tempDir, "src/main.tsx"), "console.log('boot')\n", "utf8");

  const server = createRelayServer(config);
  const headers = { "x-dev-log-relay-workspace-root": tempDir };
  const [detected, resolution, projectCheck] = await Promise.all([
    server.inject({ method: "GET", url: "/ai/targets/detect?target=auto", headers }),
    server.inject({ method: "GET", url: "/ai/project/resolution?target=auto", headers }),
    server.inject({ method: "GET", url: "/ai/web/project-check", headers }),
  ]);

  assert.equal(detected.statusCode, 200);
  assert.equal(detected.json().detection.detectedTarget, "web");
  assert.equal(resolution.statusCode, 200);
  assert.equal(resolution.json().resolution.workspaceRoot, tempDir);
  assert.equal(projectCheck.statusCode, 200);
  assert.equal(projectCheck.json().report.framework, "react-vite");
  await server.close();
});

test("server exposes detection, scenario, baseline, and summary endpoints", async () => {
  const server = createRelayServer(config);
  const detected = await server.inject({ method: "GET", url: "/ai/targets/detect?target=auto" });
  assert.equal(detected.statusCode, 200);
  assert.ok(detected.json().detection);

  const runStart = await server.inject({
    method: "POST",
    url: "/runs/start",
    payload: { label: "scenario endpoints", target: "web" },
  });
  const runId = runStart.json().runId as string;
  const stepStart = await server.inject({
    method: "POST",
    url: `/runs/${runId}/steps/start`,
    payload: { name: "load", kind: "navigate", route: "/demo" },
  });
  const stepId = stepStart.json().stepId as string;
  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: { source: "admin-web", level: "info", message: "route changed", phase: "navigation", runId, stepId, route: "/demo" },
  });
  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: { source: "admin-web", level: "info", message: "GET /api/demo", phase: "network", runId, stepId, route: "/demo", network: { url: "/api/demo", method: "GET", stage: "success" } },
  });
  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: { source: "admin-web", level: "info", message: "render_complete demo", phase: "render", tags: ["render_complete"], runId, stepId, route: "/demo" },
  });
  await server.inject({ method: "POST", url: `/runs/${runId}/steps/${stepId}/end`, payload: { status: "passed" } });
  await server.inject({ method: "POST", url: `/runs/${runId}/end`, payload: { status: "passed" } });

  const scenario = await server.inject({
    method: "POST",
    url: "/scenarios/validate",
    payload: { runId, templateName: "request_to_ui_continuity", target: "web" },
  });
  assert.equal(scenario.statusCode, 200);

  const scenarioView = await server.inject({ method: "GET", url: `/ai/run/${runId}/scenario` });
  assert.equal(scenarioView.statusCode, 200);
  const baseline = await server.inject({ method: "GET", url: `/ai/run/${runId}/baseline` });
  assert.equal(baseline.statusCode, 200);
  const summary = await server.inject({ method: "GET", url: `/ai/run/${runId}/summary-view` });
  assert.equal(summary.statusCode, 200);
  const prComment = await server.inject({ method: "GET", url: `/ai/run/${runId}/pr-comment` });
  assert.equal(prComment.statusCode, 200);
  const rootCauseMap = await server.inject({ method: "GET", url: `/ai/run/${runId}/root-cause-map` });
  assert.equal(rootCauseMap.statusCode, 200);

  await server.close();
});

test("cli exposes detect, scenario, baseline, and summary commands", async () => {
  const outputs: string[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/ai/targets/detect")) {
      return new Response(JSON.stringify({ ok: true, detection: { detectedTarget: "web", status: "detected_supported" } }), { status: 200 });
    }
    if (url.includes("/scenarios/validate")) {
      return new Response(JSON.stringify({ ok: true, scenario: { runId: "run-1", scenarioId: "request_to_ui_continuity", status: "passed" } }), { status: 200 });
    }
    if (url.includes("/ai/run/run-1/baseline")) {
      return new Response(JSON.stringify({ ok: true, baseline: { runId: "run-1", scenarioId: "request_to_ui_continuity" } }), { status: 200 });
    }
    if (url.includes("/ai/diff/scenario")) {
      return new Response(JSON.stringify({ ok: true, changed: [{ kind: "state", key: "request_done->ui_updated" }] }), { status: 200 });
    }
    if (url.includes("/ai/diff/state")) {
      return new Response(JSON.stringify({ ok: true, changed: [{ kind: "state", key: "request_done->ui_updated" }] }), { status: 200 });
    }
    if (url.includes("/ai/run/run-1/summary-view")) {
      return new Response(JSON.stringify({ ok: true, summary: { title: "Run run-1", verdict: "resolved" } }), { status: 200 });
    }
    if (url.includes("/ai/run/run-1/failure-report")) {
      return new Response(JSON.stringify({ ok: true, failureReport: { runId: "run-1" } }), { status: 200 });
    }
    if (url.includes("/ai/run/run-1/pr-comment")) {
      return new Response(JSON.stringify({ ok: true, prComment: { verdict: "resolved" } }), { status: 200 });
    }
    if (url.includes("/ai/templates")) {
      return new Response(JSON.stringify({ ok: true, templates: [{ id: "request_to_ui_continuity" }] }), { status: 200 });
    }
    if (url.includes("/ai/project/compatibility")) {
      return new Response(JSON.stringify({ ok: true, compatibility: { target: "web", relayInsertionReadiness: "ready" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, method: init?.method || "GET" }), { status: 200 });
  }) as typeof fetch;

  assert.equal(await runCli(["doctor", "detect", "--target", "auto"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("detected_supported"));
  outputs.length = 0;

  assert.equal(await runCli(["template", "list"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("request_to_ui_continuity"));
  outputs.length = 0;

  assert.equal(await runCli(["project", "compatibility", "--target", "web"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("relayInsertionReadiness"));
  outputs.length = 0;

  assert.equal(await runCli(["scenario", "validate", "--runId", "run-1", "--templateName", "request_to_ui_continuity"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("scenarioId"));
  outputs.length = 0;

  assert.equal(await runCli(["baseline", "compare", "--baselineRunId", "base-1", "--currentRunId", "run-1"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("scenarioDiff"));
  outputs.length = 0;

  assert.equal(await runCli(["ai", "summary", "--runId", "run-1"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("Run run-1"));
  outputs.length = 0;

  assert.equal(await runCli(["ai", "failure-report", "--runId", "run-1"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("failureReport"));
  outputs.length = 0;

  assert.equal(await runCli(["ai", "pr-comment", "--runId", "run-1"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("prComment"));
});

test("cli loop web keeps runner stdout out of top-level machine output", async () => {
  const outputs: string[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/ai/targets/support")) {
      return new Response(JSON.stringify({ ok: true, report: { target: "web", status: "supported", reasonCode: "web_supported", reason: "supported", recommendedAction: "relay loop web", supportedTargets: ["web", "miniapp"], currentCapabilities: ["driver"], recommendedIntegrationMode: "browser-injected", evidenceSource: "runtime_relay" } }), { status: 200 });
    }
    if (url.endsWith("/orchestrations/start")) {
      return new Response(JSON.stringify({ ok: true, runId: "run-loop-1" }), { status: 200 });
    }
    if (url.includes("/summary")) {
      return new Response(JSON.stringify({ ok: true, summary: { runId: "run-loop-1" } }), { status: 200 });
    }
    if (url.includes("/collection")) {
      return new Response(JSON.stringify({ ok: true, collection: { runId: "run-loop-1", status: "complete", signalGaps: [] } }), { status: 200 });
    }
    if (url.includes("/diagnosis")) {
      return new Response(JSON.stringify({ ok: true, diagnosis: { runId: "run-loop-1", suspectedRootCauses: [], missingSignals: [], topIncidents: [] } }), { status: 200 });
    }
    if (url.includes("/closure")) {
      return new Response(JSON.stringify({ ok: true, closure: { decision: { status: "resolved" } } }), { status: 200 });
    }
    if (url.includes("/integrity")) {
      return new Response(JSON.stringify({ ok: true, integrity: { runId: "run-loop-1", integrityScore: 100, warnings: [] } }), { status: 200 });
    }
    if (url.includes("/scenario")) {
      return new Response(JSON.stringify({ ok: true, scenario: { runId: "run-loop-1", scenarioId: "request_to_ui_continuity", status: "passed" } }), { status: 200 });
    }
    if (url.includes("/baseline")) {
      return new Response(JSON.stringify({ ok: true, baseline: { runId: "run-loop-1", scenarioId: "request_to_ui_continuity", evidenceLayer: "user_flow_closed" } }), { status: 200 });
    }
    if (url.includes("/report")) {
      return new Response(JSON.stringify({ ok: true, report: { runId: "run-loop-1", verdict: { status: "resolved" } } }), { status: 200 });
    }
    if (url.includes("/artifact")) {
      return new Response(JSON.stringify({ ok: true, artifact: { run: { id: "run-loop-1" } }, filePath: "/tmp/run-loop-1.json" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, changed: [] }), { status: 200 });
  }) as typeof fetch;

  const spawnImpl = ((_: string, __: readonly string[]) => {
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn> & { stdout?: EventEmitter; stderr?: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout?.emit("data", '{\n  "ok": true,\n  "fromRunner": true\n}\n');
      child.emit("exit", 0);
    });
    return child;
  }) as any;

  const code = await runCli(["loop", "web", "--mode", "baseline"], {
    fetchImpl,
    spawnImpl,
    stdout: (text) => outputs.push(text),
    stderr: (text) => outputs.push(text),
  });
  assert.equal(code, 0);
  assert.equal(outputs.length, 1);
  const parsed = JSON.parse(outputs[0]);
  assert.equal(parsed.runId, "run-loop-1");
  assert.equal(parsed.exampleEvidence?.fromRunner, true);
});

test("project resolution handles monorepo next apps and exposes resolution report", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-log-relay-next-monorepo-"));
  await writeFile(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      name: "mono-root",
      workspaces: ["apps/*", "packages/*"],
    }),
    "utf8"
  );
  await mkdir(path.join(tempDir, "apps/admin/app"), { recursive: true });
  await writeFile(
    path.join(tempDir, "apps/admin/package.json"),
    JSON.stringify({
      name: "admin",
      dependencies: { next: "^15.0.0", react: "^18.0.0" },
    }),
    "utf8"
  );
  await writeFile(path.join(tempDir, "apps/admin/app/layout.tsx"), "export default function Layout() { return null }\n", "utf8");
  await writeFile(path.join(tempDir, "apps/admin/app/error.tsx"), "export default function Error() { return null }\n", "utf8");

  const previousCwd = process.cwd();
  try {
    process.chdir(tempDir);
    const engine = new RelayEngine(config);
    const resolution = await engine.getProjectResolution("auto");
    assert.equal(resolution.target, "web");
    assert.equal(resolution.packageTopology.monorepo, true);
    assert.equal(resolution.framework, "nextjs");
    assert.ok(resolution.entrypoints.some((item) => item.path.includes("app/layout")));
  } finally {
    process.chdir(previousCwd);
  }
});

test("release decision and executable handoff distinguish integration from business failure", () => {
  const engine = new RelayEngine(config);
  const run = engine.startRun({ label: "business failure", target: "web", metadata: { driver: "computer-use" } });
  const step = engine.startStep(run.id, { name: "load detail", kind: "navigate", route: "/detail" });
  engine.ingest({ source: "admin-web", level: "info", message: "route changed", phase: "navigation", runId: run.id, stepId: step?.id, route: "/detail" });
  engine.ingest({ source: "admin-web", level: "info", message: "GET /api/detail", phase: "network", runId: run.id, stepId: step?.id, route: "/detail", network: { url: "/api/detail", method: "GET", stage: "success" } });
  engine.ingest({ source: "admin-web", level: "info", message: "render_complete detail", phase: "render", tags: ["render_complete"], runId: run.id, stepId: step?.id, route: "/detail" });
  engine.ingest({ source: "admin-web", level: "error", message: "detail empty state broken", runId: run.id, stepId: step?.id, route: "/detail" });
  engine.endStep(run.id, step!.id, { status: "failed" });
  engine.endRun(run.id, { status: "failed" });

  const release = engine.getRunReleaseDecision(run.id);
  assert.equal(release?.decision, "hold");
  assert.ok(release?.blockingItems.length);

  const handoff = engine.getExecutableHandoff(run.id);
  assert.equal(handoff?.failureFamily, "business_failure");
  assert.ok(handoff?.recommendedInvestigationEntry.length);
});

test("run-scoped action, state, request attribution, and CI result are derived", () => {
  const engine = new RelayEngine(config);
  const run = engine.startRun({ label: "ci run", target: "web", metadata: { driver: "computer-use" } });
  const step = engine.startStep(run.id, { name: "open home", kind: "navigate", route: "/" });
  engine.ingest({ source: "admin-web", level: "info", message: "route changed", phase: "navigation", runId: run.id, stepId: step?.id, route: "/" });
  engine.ingest({ source: "admin-web", level: "info", message: "GET /api/home", phase: "network", runId: run.id, stepId: step?.id, route: "/", network: { url: "/api/home", method: "GET", stage: "success" } });
  engine.ingest({ source: "admin-web", level: "info", message: "render_complete home", phase: "render", tags: ["render_complete"], runId: run.id, stepId: step?.id, route: "/" });
  engine.ingest({
    source: "admin-web",
    level: "info",
    message: "home state applied",
    phase: "lifecycle",
    tags: ["state_update"],
    context: { state: "ready" },
    runId: run.id,
    stepId: step?.id,
    route: "/",
  });
  engine.endStep(run.id, step!.id, { status: "passed" });
  engine.endRun(run.id, { status: "passed" });
  engine.validateScenario(run.id, engine.getScenarioTemplate("web_home_cold_start", "web")!);

  const actions = engine.getRunActions(run.id);
  const snapshots = engine.getRunStateSnapshots(run.id);
  const attribution = engine.getRunRequestAttribution(run.id);
  const ci = engine.getCiVerificationResult("closure", run.id);

  assert.equal(actions.length, 1);
  assert.ok(snapshots.length >= 1);
  assert.ok(attribution.length >= 1);
  assert.equal(ci.recommendedExitCode, 2);
});

test("request attribution distinguishes missing state after render", () => {
  const engine = new RelayEngine(config);
  const run = engine.startRun({ label: "attribution gap", target: "web" });
  const step = engine.startStep(run.id, { name: "load", kind: "navigate", route: "/" });
  engine.ingest({ source: "admin-web", level: "info", message: "GET /api/home", phase: "network", runId: run.id, stepId: step?.id, route: "/", network: { url: "/api/home", method: "GET", stage: "success" } });
  engine.ingest({ source: "admin-web", level: "info", message: "render only", phase: "render", runId: run.id, stepId: step?.id, route: "/" });
  engine.endStep(run.id, step!.id, { status: "passed" });
  engine.endRun(run.id, { status: "passed" });

  const attribution = engine.getRunRequestAttribution(run.id);
  assert.equal(attribution[0]?.attributionStatus, "missing_state");
});

test("miniapp run-scoped observation requires request to lifecycle/state continuity", () => {
  const engine = new RelayEngine(config);
  const run = engine.startRun({ label: "miniapp observe", target: "miniapp" });
  const step = engine.startStep(run.id, { name: "open home", kind: "navigate", route: "/pages/home/index", metadata: { projectRoot: "/tmp/demo-miniapp" } });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "navigateTo /pages/home/index",
    phase: "navigation",
    tags: ["route_transition"],
    runId: run.id,
    stepId: step?.id,
    route: "/pages/home/index",
    context: { destinationRoute: "/pages/home/index", pageStackRoutes: ["pages/home/index"] },
  });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "HomePage.onLoad",
    phase: "lifecycle",
    tags: ["lifecycle_hook"],
    runId: run.id,
    stepId: step?.id,
    route: "/pages/home/index",
    context: { hookName: "onLoad" },
  });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "wx.request GET /home",
    phase: "network",
    requestId: "req-1",
    runId: run.id,
    stepId: step?.id,
    route: "/pages/home/index",
    network: { url: "/home", method: "GET", stage: "success", ok: true },
  });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "HomePage.setData",
    phase: "lifecycle",
    tags: ["setData", "state_update", "state_signature"],
    runId: run.id,
    stepId: step?.id,
    route: "/pages/home/index",
    context: { hookName: "onLoad", keys: ["list", "ready"], stateSignature: "list|ready" },
  });
  engine.endStep(run.id, step!.id, { status: "passed" });
  engine.endRun(run.id, { status: "passed" });

  const observation = engine.getMiniappSignalReport(run.id);
  const readiness = engine.getRunReadiness(run.id);
  const attribution = engine.getRunRequestAttribution(run.id);

  assert.equal(observation?.observationReady, true);
  assert.equal(observation?.requestAttributionCoverage, 100);
  assert.ok(observation?.stateSignatures.includes("list|ready"));
  assert.equal(readiness?.bestPracticeCompliant, true);
  assert.equal(attribution[0]?.attributionStatus, "attributed");
});

test("miniapp request attribution distinguishes missing lifecycle from missing state", () => {
  const engine = new RelayEngine(config);
  const run = engine.startRun({ label: "miniapp gaps", target: "miniapp" });
  const step = engine.startStep(run.id, { name: "open", kind: "navigate", route: "/pages/gap/index" });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "wx.request GET /gap",
    phase: "network",
    runId: run.id,
    stepId: step?.id,
    route: "/pages/gap/index",
    network: { url: "/gap", method: "GET", stage: "success", ok: true },
  });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "GapPage.onLoad",
    phase: "lifecycle",
    tags: ["lifecycle_hook"],
    runId: run.id,
    stepId: step?.id,
    route: "/pages/gap/index",
    context: { hookName: "onLoad" },
  });
  engine.endStep(run.id, step!.id, { status: "passed" });
  engine.endRun(run.id, { status: "passed" });

  const attribution = engine.getRunRequestAttribution(run.id);
  assert.equal(attribution[0]?.attributionStatus, "missing_state");

  const run2 = engine.startRun({ label: "miniapp no lifecycle", target: "miniapp" });
  const step2 = engine.startStep(run2.id, { name: "open", kind: "navigate", route: "/pages/gap2/index" });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "wx.request GET /gap2",
    phase: "network",
    runId: run2.id,
    stepId: step2?.id,
    route: "/pages/gap2/index",
    network: { url: "/gap2", method: "GET", stage: "success", ok: true },
  });
  engine.endStep(run2.id, step2!.id, { status: "passed" });
  engine.endRun(run2.id, { status: "passed" });

  const attribution2 = engine.getRunRequestAttribution(run2.id);
  assert.equal(attribution2[0]?.attributionStatus, "missing_lifecycle");
});

test("miniapp release decision upgrades from hold to ship only after blocking scenario passes", () => {
  const engine = new RelayEngine(config);
  const run = engine.startRun({ label: "miniapp closure", target: "miniapp", metadata: { driver: "devtools-automator" } });
  const step = engine.startStep(run.id, {
    name: "enter home",
    kind: "navigate",
    route: "/pages/home/index",
    metadata: { actionType: "enter_page", pagePath: "/pages/home/index", triggerSource: "reference_driver" },
  });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "navigateTo /pages/home/index",
    phase: "navigation",
    tags: ["route_transition"],
    runId: run.id,
    stepId: step?.id,
    route: "/pages/home/index",
    context: { destinationRoute: "/pages/home/index", pageStackRoutes: ["pages/home/index"] },
  });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "HomePage.onLoad",
    phase: "lifecycle",
    tags: ["lifecycle_hook", "ready"],
    runId: run.id,
    stepId: step?.id,
    route: "/pages/home/index",
    context: { hookName: "onLoad" },
  });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "wx.request GET /home",
    phase: "network",
    requestId: "req-miniapp-1",
    runId: run.id,
    stepId: step?.id,
    route: "/pages/home/index",
    network: { url: "/home", method: "GET", stage: "success", ok: true },
  });
  engine.ingest({
    source: "miniapp",
    level: "info",
    message: "HomePage.setData ready",
    phase: "lifecycle",
    tags: ["setData", "state_update", "state_signature", "ready"],
    runId: run.id,
    stepId: step?.id,
    route: "/pages/home/index",
    context: { hookName: "onLoad", keys: ["list", "ready"], stateSignature: "list|ready" },
  });
  engine.endStep(run.id, step!.id, { status: "passed" });
  engine.endRun(run.id, { status: "passed" });

  const beforeScenario = engine.getRunReleaseDecision(run.id);
  assert.equal(beforeScenario?.decision, "hold");
  assert.ok(beforeScenario?.blockingItems.includes("missing_scenario_validation"));

  const scenario = engine.validateScenario(run.id, engine.getScenarioTemplate("miniapp_home_entry", "miniapp")!);
  assert.equal(scenario?.status, "passed");

  const afterScenario = engine.getRunReleaseDecision(run.id);
  assert.equal(afterScenario?.decision, "ship");
  assert.equal(afterScenario?.evidenceLayer, "user_flow_closed");
});

test("server exposes miniapp observation alias alongside legacy miniapp signals", async () => {
  const server = createRelayServer(config);
  const runStart = await server.inject({
    method: "POST",
    url: "/runs/start",
    payload: { label: "miniapp observation alias", target: "miniapp", metadata: { driver: "devtools-automator" } },
  });
  const runId = runStart.json().runId as string;
  const stepStart = await server.inject({
    method: "POST",
    url: `/runs/${runId}/steps/start`,
    payload: {
      name: "enter home",
      kind: "navigate",
      route: "/pages/home/index",
      metadata: { actionType: "enter_page", pagePath: "/pages/home/index", triggerSource: "reference_driver" },
    },
  });
  const stepId = stepStart.json().stepId as string;
  await server.inject({
    method: "POST",
    url: "/ingest",
    payload: {
      runId,
      stepId,
      records: [
        {
          source: "miniapp",
          level: "info",
          message: "navigateTo /pages/home/index",
          phase: "navigation",
          route: "/pages/home/index",
          tags: ["route_transition"],
          context: { destinationRoute: "/pages/home/index", pageStackRoutes: ["pages/home/index"] },
        },
        {
          source: "miniapp",
          level: "info",
          message: "HomePage.onLoad",
          phase: "lifecycle",
          route: "/pages/home/index",
          tags: ["lifecycle_hook"],
          context: { hookName: "onLoad" },
        },
        {
          source: "miniapp",
          level: "info",
          message: "wx.request GET /home",
          phase: "network",
          route: "/pages/home/index",
          requestId: "server-miniapp-1",
          network: { url: "/home", method: "GET", stage: "success", ok: true },
        },
        {
          source: "miniapp",
          level: "info",
          message: "HomePage.setData ready",
          phase: "lifecycle",
          route: "/pages/home/index",
          tags: ["setData", "state_update", "state_signature"],
          context: { hookName: "onLoad", keys: ["list", "ready"], stateSignature: "list|ready" },
        },
      ],
    },
  });
  await server.inject({ method: "POST", url: `/runs/${runId}/steps/${stepId}/end`, payload: { status: "passed" } });
  await server.inject({ method: "POST", url: `/runs/${runId}/end`, payload: { status: "passed" } });

  const [alias, legacy] = await Promise.all([
    server.inject({ method: "GET", url: `/ai/run/${runId}/miniapp-observation` }),
    server.inject({ method: "GET", url: `/ai/run/${runId}/miniapp-signals` }),
  ]);
  assert.equal(alias.statusCode, 200);
  assert.equal(legacy.statusCode, 200);
  assert.equal(alias.json().miniappObservation.observationReady, true);
  assert.equal(alias.json().miniappObservation.requestAttributionCoverage, legacy.json().miniappSignals.requestAttributionCoverage);
  await server.close();
});

test("cli miniapp run, scenario, closure, and external bridge produce run-scoped closure outputs", async () => {
  const workspaceRoot = await createMiniappProjectFixture();
  const fixtureModule = path.join(process.cwd(), "tests/fixtures/miniapp-driver-module.mjs");
  const server = createRelayServer({ ...config, port: 0 });
  const relay = await server.listen({ port: 0, host: "127.0.0.1" });
  const relayUrl = typeof relay === "string" ? relay.replace(/\/$/, "") : `http://127.0.0.1:${config.port}`;
  const previousWorkspaceRoot = process.env.DEV_LOG_RELAY_WORKSPACE_ROOT;
  const outputs: string[] = [];

  process.env.DEV_LOG_RELAY_WORKSPACE_ROOT = workspaceRoot;
  try {
    const runCode = await runCli(
      ["miniapp", "run", "--relay", relayUrl, "--driver", "devtools-automator", "--driverModule", fixtureModule, "--templateName", "miniapp_home_entry"],
      {
        stdout: (text) => outputs.push(text),
        stderr: (text) => outputs.push(text),
      }
    );
    assert.equal(runCode, 0);
    const runPayload = JSON.parse(outputs.join(""));
    assert.equal(runPayload.ok, true);
    assert.equal(runPayload.execution.status, "executed");
    assert.equal(runPayload.scenarioResult.status, "passed");
    assert.equal(runPayload.miniappObservation.observationReady, true);
    assert.equal(runPayload.contract.target, "miniapp");
    assert.ok(["ship", "manual_review_required"].includes(runPayload.releaseDecision.decision));

    outputs.length = 0;
    const scenarioCode = await runCli(
      ["miniapp", "scenario", "--relay", relayUrl, "--runId", runPayload.runId, "--templateName", "miniapp_home_entry"],
      {
        stdout: (text) => outputs.push(text),
        stderr: (text) => outputs.push(text),
      }
    );
    assert.equal(scenarioCode, 0);
    const scenarioPayload = JSON.parse(outputs.join(""));
    assert.equal(scenarioPayload.scenario.status, "passed");
    assert.equal(scenarioPayload.miniappObservation.observationReady, true);

    outputs.length = 0;
    const closureCode = await runCli(
      ["miniapp", "closure", "--relay", relayUrl, "--runId", runPayload.runId, "--driver", "devtools-automator"],
      {
        stdout: (text) => outputs.push(text),
        stderr: (text) => outputs.push(text),
      }
    );
    const closurePayload = JSON.parse(outputs.join(""));
    assert.equal(closurePayload.runId, runPayload.runId);
    assert.equal(closurePayload.driverContract.target, "miniapp");
    assert.ok(["ship", "manual_review_required"].includes(closurePayload.releaseDecision.decision));
    assert.equal(closureCode, closurePayload.releaseDecision.decision === "hold" ? 1 : 0);

    outputs.length = 0;
    const bridgeCode = await runCli(["miniapp", "run", "--relay", relayUrl, "--driver", "external-agent", "--templateName", "miniapp_home_entry"], {
      stdout: (text) => outputs.push(text),
      stderr: (text) => outputs.push(text),
    });
    assert.equal(bridgeCode, 0);
    const bridgePayload = JSON.parse(outputs.join(""));
    assert.equal(bridgePayload.status, "bridge_required");
    assert.ok(Array.isArray(bridgePayload.actionPlan));
    assert.ok(bridgePayload.actionPlan.length > 0);
    assert.equal(bridgePayload.contract.target, "miniapp");

    const bridgeClosure = await server.inject({ method: "GET", url: `/ai/run/${bridgePayload.runId}/closure` });
    assert.equal(bridgeClosure.statusCode, 200);
    assert.equal(bridgeClosure.json().closure.decision.status, "running");
  } finally {
    process.env.DEV_LOG_RELAY_WORKSPACE_ROOT = previousWorkspaceRoot;
    await server.close();
  }
});

test("server exposes project resolution, release decision, run-scoped views, and executable handoff", async () => {
  const server = createRelayServer(config);
  const runStart = await server.inject({
    method: "POST",
    url: "/runs/start",
    payload: { label: "extended endpoints", target: "web", metadata: { driver: "computer-use" } },
  });
  const runId = runStart.json().runId as string;
  const stepStart = await server.inject({
    method: "POST",
    url: `/runs/${runId}/steps/start`,
    payload: { name: "load", kind: "navigate", route: "/" },
  });
  const stepId = stepStart.json().stepId as string;
  await server.inject({ method: "POST", url: "/ingest", payload: { source: "admin-web", level: "info", message: "route changed", phase: "navigation", runId, stepId, route: "/" } });
  await server.inject({ method: "POST", url: "/ingest", payload: { source: "admin-web", level: "info", message: "GET /api/home", phase: "network", runId, stepId, route: "/", network: { url: "/api/home", method: "GET", stage: "success" } } });
  await server.inject({ method: "POST", url: "/ingest", payload: { source: "admin-web", level: "info", message: "render_complete home", phase: "render", tags: ["render_complete"], runId, stepId, route: "/" } });
  await server.inject({ method: "POST", url: `/runs/${runId}/steps/${stepId}/end`, payload: { status: "passed" } });
  await server.inject({ method: "POST", url: `/runs/${runId}/end`, payload: { status: "passed" } });
  await server.inject({ method: "POST", url: "/scenarios/validate", payload: { runId, templateName: "web_home_cold_start", target: "web" } });

  const [resolution, actions, stateSnapshots, requestAttribution, releaseDecision, verificationReport, handoff] = await Promise.all([
    server.inject({ method: "GET", url: "/ai/project/resolution?target=auto" }),
    server.inject({ method: "GET", url: `/ai/run/${runId}/actions` }),
    server.inject({ method: "GET", url: `/ai/run/${runId}/state-snapshots` }),
    server.inject({ method: "GET", url: `/ai/run/${runId}/request-attribution` }),
    server.inject({ method: "GET", url: `/ai/run/${runId}/release-decision` }),
    server.inject({ method: "GET", url: `/ai/run/${runId}/verification-report` }),
    server.inject({ method: "GET", url: `/ai/run/${runId}/executable-handoff` }),
  ]);

  assert.equal(resolution.statusCode, 200);
  assert.equal(actions.statusCode, 200);
  assert.equal(stateSnapshots.statusCode, 200);
  assert.equal(requestAttribution.statusCode, 200);
  assert.equal(releaseDecision.statusCode, 200);
  assert.equal(verificationReport.statusCode, 200);
  assert.equal(handoff.statusCode, 200);
  await server.close();
});

test("cli exposes scenario list and CI commands with stable exit codes", async () => {
  const outputs: string[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/ai/scenarios")) {
      return new Response(JSON.stringify({ ok: true, scenarios: [{ id: "web_home_cold_start" }] }), { status: 200 });
    }
    if (url.includes("/ai/project/scenarios")) {
      return new Response(JSON.stringify({ ok: true, scenarios: [{ id: "miniapp_home_entry" }] }), { status: 200 });
    }
    if (url.includes("/ai/project/baselines")) {
      return new Response(JSON.stringify({ ok: true, baselines: { entries: [{ baselineKey: "miniapp_home_entry:home" }] } }), { status: 200 });
    }
    if (url.includes("/ai/scenario/inspect")) {
      return new Response(JSON.stringify({ ok: true, inspection: { found: true, resolvedFrom: "project_local" } }), { status: 200 });
    }
    if (url.includes("/ai/diff/regression")) {
      return new Response(JSON.stringify({ ok: true, regression: { decision: "hold", failedChecks: ["request:GET /home:removed"], blockingReasons: ["request:GET /home:removed"], baselineRefs: ["run:baseline-1"] } }), { status: 200 });
    }
    if (url.includes("/verification-report")) {
      return new Response(JSON.stringify({ ok: true, verificationReport: { runtimeReadiness: { bestPracticeCompliant: false, evidenceLevel: "project_only", missingSignals: ["render"], blockingReasons: ["render"] }, closure: { baselineRunId: "baseline-1" }, releaseDecision: { decision: "manual_review_required", baselineRefs: ["run:baseline-1"] }, blockingItems: ["runtime_not_observed"] } }), { status: 200 });
    }
    if (url.includes("/release-decision")) {
      return new Response(JSON.stringify({ ok: true, releaseDecision: { decision: "hold", blockingItems: ["assertion_failed"], baselineRefs: ["run:baseline-1"] } }), { status: 200 });
    }
    if (url.includes("/scenario")) {
      return new Response(JSON.stringify({ ok: true, scenario: { status: "passed", missingEvidence: [], baselineKey: "miniapp_home_entry:home" } }), { status: 200 });
    }
    if (url.includes("/report")) {
      return new Response(JSON.stringify({ ok: true, report: { releaseDecision: { decision: "ship" }, blockingItems: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  assert.equal(await runCli(["scenario", "list"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("web_home_cold_start"));
  outputs.length = 0;

  assert.equal(await runCli(["project", "scenarios"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("miniapp_home_entry"));
  outputs.length = 0;

  assert.equal(await runCli(["project", "baselines"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("miniapp_home_entry:home"));
  outputs.length = 0;

  assert.equal(await runCli(["scenario", "inspect", "--templateName", "miniapp_home_entry"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  assert.ok(outputs.join("").includes("project_local"));
  outputs.length = 0;

  assert.equal(await runCli(["ci", "readiness", "--runId", "run-1"], { fetchImpl, stdout: (text) => outputs.push(text) }), 3);
  outputs.length = 0;
  assert.equal(await runCli(["ci", "closure", "--runId", "run-1"], { fetchImpl, stdout: (text) => outputs.push(text) }), 3);
  outputs.length = 0;
  assert.equal(await runCli(["ci", "report", "--runId", "run-1"], { fetchImpl, stdout: (text) => outputs.push(text) }), 0);
  outputs.length = 0;
  assert.equal(await runCli(["ci", "regression", "--runId", "run-1"], { fetchImpl, stdout: (text) => outputs.push(text) }), 3);
});

test("engine loads local scenario catalog and baseline registry, and regression diff classifies blocking changes", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dev-log-relay-scenarios-"));
  await mkdir(path.join(workspaceRoot, "tooling/scenarios"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "tooling/baselines"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "tooling/scenarios/miniapp_checkout.json"),
    JSON.stringify({
      id: "miniapp_checkout_submit",
      target: "miniapp",
      pageKey: "checkout",
      templateName: "miniapp_checkout_submit",
      blockingByDefault: true,
      baselinePolicy: "when_passed",
      entry: { page: "/pages/checkout/index" },
      steps: [
        { id: "route", kind: "route_change", eventPhase: "navigation", route: "/pages/checkout/index" },
        { id: "request", kind: "wait_request_complete", eventPhase: "network" },
      ],
      expectations: ["checkout request completes"],
      fallbacks: [],
      assertions: [{ id: "ready", type: "continuity", match: "ready", blocking: true }],
      stateTransitions: [{ from: "loading", to: "ready", evidenceMatch: "ready" }],
    }),
    "utf8"
  );
  await writeFile(
    path.join(workspaceRoot, "tooling/baselines/miniapp_checkout.json"),
    JSON.stringify({
      runId: "baseline-file",
      scenarioId: "miniapp_checkout_submit",
      pageKey: "checkout",
      baselineKey: "miniapp_checkout_submit:checkout",
      keyStepSequence: ["navigate:checkout"],
      requestSequence: ["GET /checkout"],
      stateSignatures: ["ready"],
      stateTransitions: ["loading->ready"],
      assertionResults: [{ id: "ready", status: "passed" }],
      signalPresence: ["network", "lifecycle"],
      evidenceLayer: "user_flow_closed",
    }),
    "utf8"
  );

  const previousRoot = process.env.DEV_LOG_RELAY_WORKSPACE_ROOT;
  process.env.DEV_LOG_RELAY_WORKSPACE_ROOT = workspaceRoot;
  try {
    const engine = new RelayEngine(config);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const catalog = engine.listProjectScenarioCatalog("miniapp");
    assert.ok(catalog.scenarios.some((entry) => entry.scenario.id === "miniapp_checkout_submit" && entry.source === "project_local"));

    const baselines = engine.listProjectBaselines("miniapp");
    assert.ok(baselines.entries.some((entry) => entry.scenarioId === "miniapp_checkout_submit" && entry.source === "project_local"));

    const baselineRun = engine.startRun({ label: "baseline", target: "miniapp" });
    const baselineStep = engine.startStep(baselineRun.id, {
      name: "checkout baseline",
      kind: "navigate",
      route: "/pages/checkout/index",
      metadata: { actionType: "enter_page", pagePath: "/pages/checkout/index" },
    });
    assert.ok(baselineStep);
    engine.ingest({
      source: "miniapp",
      level: "info",
      message: "route ready",
      runId: baselineRun.id,
      stepId: baselineStep!.id,
      route: "/pages/checkout/index",
      phase: "navigation",
      tags: ["route_transition"],
    });
    engine.ingest({
      source: "miniapp",
      level: "info",
      message: "checkout request ready",
      runId: baselineRun.id,
      stepId: baselineStep!.id,
      route: "/pages/checkout/index",
      phase: "network",
      network: { url: "/checkout", method: "GET", statusCode: 200, ok: true, stage: "complete" },
      tags: ["ready"],
    });
    engine.endStep(baselineRun.id, baselineStep!.id, { status: "passed" });
    engine.endRun(baselineRun.id, { status: "passed" });
    engine.validateScenario(baselineRun.id, engine.getScenarioTemplate("miniapp_checkout_submit", "miniapp")!);

    const currentRun = engine.startRun({ label: "current", target: "miniapp" });
    const currentStep = engine.startStep(currentRun.id, {
      name: "checkout current",
      kind: "navigate",
      route: "/pages/checkout/index",
      metadata: { actionType: "enter_page", pagePath: "/pages/checkout/index" },
    });
    assert.ok(currentStep);
    engine.ingest({
      source: "miniapp",
      level: "info",
      message: "route ready",
      runId: currentRun.id,
      stepId: currentStep!.id,
      route: "/pages/checkout/index",
      phase: "navigation",
      tags: ["route_transition"],
    });
    engine.ingest({
      source: "miniapp",
      level: "info",
      message: "checkout request changed",
      runId: currentRun.id,
      stepId: currentStep!.id,
      route: "/pages/checkout/index",
      phase: "network",
      network: { url: "/checkout?mode=fast", method: "GET", statusCode: 200, ok: true, stage: "complete" },
    });
    engine.endStep(currentRun.id, currentStep!.id, { status: "passed" });
    engine.endRun(currentRun.id, { status: "passed" });
    engine.validateScenario(currentRun.id, engine.getScenarioTemplate("miniapp_checkout_submit", "miniapp")!);

    const regression = engine.getRegressionDiff(baselineRun.id, currentRun.id, "miniapp_checkout_submit");
    assert.equal(regression.decision, "hold");
    assert.ok(regression.blockingDiffs.length > 0);
    assert.ok(regression.failedChecks.some((item) => item.includes("request:GET /checkout")));
  } finally {
    process.env.DEV_LOG_RELAY_WORKSPACE_ROOT = previousRoot;
  }
});
