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
    } else if (url.endsWith("/repair-brief")) {
      body = { ok: true, repairBrief: { successCriteria: ["closure resolved"] } };
    } else if (url.includes("/ai/autoloop/") && url.endsWith("/decision")) {
      body = url.includes("loop-1") && outputs.join("").includes("resolved")
        ? { ok: true, decision: { status: "resolved", shouldContinue: false, nextAction: "stop", confidence: 0.9, evidence: [] } }
        : { ok: true, decision: { status: "escalated", shouldContinue: true, nextAction: "repair_and_retest", confidence: 0.7, evidence: [] } };
    } else if (url.includes("/ai/autoloop/")) {
      body = { ok: true, autoloop: { session: { id: "loop-1" }, attempts: [], decision: { status: "resolved" } } };
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
  relay.startAutoCapture();
  (globalThis as any).wx.request({ url: "https://api.example.com/demo", method: "POST" });
  const check = relay.selfCheck();
  relay.stopAutoCapture();
  relay.disableMiniappRuntimePatch();

  assert.ok(calls.some((item) => item.phase === "lifecycle" && item.component === "IndexPage"));
  assert.ok(calls.some((item) => item.phase === "network"));
  assert.ok(calls.some((item) => item.runId === "run-2" && item.stepId === "step-2"));
  assert.equal(check.runBound, true);
  assert.ok(patch.appliedCapabilities.length >= 2);

  (globalThis as any).wx = originalWx;
  (globalThis as any).App = originalApp;
  (globalThis as any).Page = originalPage;
  (globalThis as any).Component = originalComponent;
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
