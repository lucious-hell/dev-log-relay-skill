import http from "node:http";
import { chromium } from "playwright";

function parseArgs(argv) {
  const options = {
    relay: "http://127.0.0.1:5077",
    runId: "",
    baselineRunId: "",
    mode: "baseline",
    templateName: "request_to_ui_continuity",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--relay") {
      options.relay = argv[index + 1] || options.relay;
      index += 1;
      continue;
    }
    if (token === "--runId") {
      options.runId = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--baselineRunId") {
      options.baselineRunId = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--mode") {
      options.mode = argv[index + 1] || options.mode;
      index += 1;
      continue;
    }
    if (token === "--templateName") {
      options.templateName = argv[index + 1] || options.templateName;
      index += 1;
    }
  }
  return options;
}

async function requestJson(relay, url, init) {
  const response = await fetch(`${relay}${url}`, init);
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(json.message || `Request failed: ${response.status}`);
  }
  return json;
}

function createDemoServer(mode, relay) {
  const server = http.createServer((req, res) => {
    if (req.url === "/relay" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          const response = await fetch(`${relay}/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          const text = await response.text();
          res.writeHead(response.status, { "Content-Type": "application/json" });
          res.end(text);
        } catch (error) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, message: String(error) }));
        }
      });
      return;
    }
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <body>
    <button id="trigger">Trigger</button>
    <div id="status">idle</div>
    <script>
      document.getElementById("trigger").addEventListener("click", async () => {
        console.info("button-clicked");
        const response = await fetch("/api/${mode}");
        const data = await response.json();
        document.getElementById("status").textContent = data.status;
        if (!response.ok) {
          console.error("request-failed", data.status);
          throw new Error("ui failure after network");
        }
        console.info("request-succeeded");
      });
    </script>
  </body>
</html>`);
      return;
    }
    if (req.url === "/api/baseline") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/api/broken") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed" }));
      return;
    }
    if (req.url === "/api/fixed") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

async function createStep(relay, runId, payload) {
  const response = await requestJson(relay, `/runs/${runId}/steps/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.stepId;
}

async function endStep(relay, runId, stepId, status) {
  await requestJson(relay, `/runs/${runId}/steps/${stepId}/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

async function endRun(relay, runId, status) {
  await requestJson(relay, `/runs/${runId}/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

async function installRelay(page, relayEndpoint, runId) {
  await page.addInitScript(
    ({ endpoint, activeRunId }) => {
      const transportFetch = window.fetch.bind(window);
      const binding = {
        runId: activeRunId,
        stepId: "",
      };

      async function post(level, message, extra = {}) {
        try {
          await transportFetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source: "admin-web",
              level,
              message,
              runId: binding.runId,
              stepId: binding.stepId,
              route: location.pathname,
              ...extra,
            }),
          });
        } catch {}
      }

      window.__relayBinding = binding;
      window.__setRelayStep = (stepId) => {
        binding.stepId = stepId || "";
      };

      const originalError = console.error.bind(console);
      const originalInfo = console.info.bind(console);
      console.error = (...args) => {
        post("error", args.map(String).join(" "), { phase: "log", context: { args } });
        originalError(...args);
      };
      console.info = (...args) => {
        post("info", args.map(String).join(" "), { phase: "log", context: { args } });
        originalInfo(...args);
      };

      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const url = String(args[0]);
        post("info", `fetch ${url}`, { phase: "network", network: { url, method: "GET", stage: "start" } });
        const response = await originalFetch(...args);
        post(response.ok ? "info" : "warn", `fetch ${url} -> ${response.status}`, {
          phase: "network",
          network: { url, method: "GET", statusCode: response.status, ok: response.ok, stage: response.ok ? "success" : "fail" },
        });
        return response;
      };

      window.addEventListener("error", (event) => {
        post("error", event.message || "window error", {
          phase: "log",
          errorKind: "window_error",
          stack: event.error && event.error.stack ? event.error.stack : "",
        });
      });

      window.addEventListener("DOMContentLoaded", () => {
        const emitRender = (reason) => {
          post("info", `render_complete:${reason}`, {
            phase: "render",
            tags: ["render_complete", "ui_updated", reason],
          });
        };
        requestAnimationFrame(() => emitRender("dom_ready"));
        const statusNode = document.getElementById("status");
        if (statusNode) {
          const observer = new MutationObserver(() => emitRender("status_changed"));
          observer.observe(statusNode, { childList: true, subtree: true, characterData: true });
        }
      });

      post("info", `route init ${location.pathname}`, {
        phase: "navigation",
        route: location.pathname,
      });
    },
    { endpoint: relayEndpoint, activeRunId: runId }
  );
}

async function setStep(page, stepId) {
  await page.evaluate((nextStepId) => {
    if (typeof window.__setRelayStep === "function") {
      window.__setRelayStep(nextStepId);
    }
  }, stepId);
}

const options = parseArgs(process.argv.slice(2));
if (!options.runId) {
  throw new Error("runId is required");
}

const { server, url } = await createDemoServer(options.mode, options.relay);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await installRelay(page, `${url}/relay`, options.runId);

  const navigateStepId = await createStep(options.relay, options.runId, {
    name: "navigate",
    kind: "navigate",
    route: "/",
  });
  await setStep(page, navigateStepId);
  await page.goto(url);
  await endStep(options.relay, options.runId, navigateStepId, "passed");

  const actionStepId = await createStep(options.relay, options.runId, {
    name: "click-trigger",
    kind: "action",
    route: "/",
  });
  await setStep(page, actionStepId);
  const clickOutcome = await page.locator("#trigger").click().then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error })
  );
  await page.waitForTimeout(200);
  await endStep(options.relay, options.runId, actionStepId, clickOutcome.ok ? "passed" : "failed");

  const assertStepId = await createStep(options.relay, options.runId, {
    name: "assert-status",
    kind: "assert",
    route: "/",
  });
  await setStep(page, assertStepId);
  const statusText = await page.locator("#status").textContent();
  const shouldPass = options.mode === "baseline" || options.mode === "fixed";
  const passed = shouldPass ? statusText === "ok" : statusText === "failed";
  await endStep(options.relay, options.runId, assertStepId, passed ? "passed" : "failed");

  await endRun(options.relay, options.runId, shouldPass && clickOutcome.ok && passed ? "passed" : "failed");
  const scenario = await requestJson(options.relay, "/scenarios/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: options.runId,
      target: "web",
      templateName: options.templateName,
    }),
  });
  const [scenarioView, stateReport, baseline, report, summary, collection, diagnosis, closure] = await Promise.all([
    requestJson(options.relay, `/ai/run/${options.runId}/scenario`),
    requestJson(options.relay, `/ai/run/${options.runId}/state-report`),
    requestJson(options.relay, `/ai/run/${options.runId}/baseline`),
    requestJson(options.relay, `/ai/run/${options.runId}/report`),
    requestJson(options.relay, `/ai/run/${options.runId}/summary`),
    requestJson(options.relay, `/ai/run/${options.runId}/collection`),
    requestJson(options.relay, `/ai/run/${options.runId}/diagnosis`),
    requestJson(options.relay, `/ai/run/${options.runId}/closure`),
  ]);
  const scenarioDiff = options.baselineRunId
    ? await requestJson(options.relay, `/ai/diff/scenario?baselineRunId=${encodeURIComponent(options.baselineRunId)}&currentRunId=${encodeURIComponent(options.runId)}`)
    : null;
  const stateDiff = options.baselineRunId
    ? await requestJson(options.relay, `/ai/diff/state?baselineRunId=${encodeURIComponent(options.baselineRunId)}&currentRunId=${encodeURIComponent(options.runId)}`)
    : null;
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        runId: options.runId,
        mode: options.mode,
        templateName: options.templateName,
        baselineRunId: options.baselineRunId || "",
        scenario: scenario.scenario,
        scenarioView: scenarioView.scenario,
        stateReport: stateReport.stateReport,
        baseline: baseline.baseline,
        scenarioDiff: scenarioDiff?.changed || [],
        stateDiff: stateDiff?.changed || [],
        summary: summary.summary,
        collection: collection.collection,
        diagnosis: diagnosis.diagnosis,
        closure: closure.closure,
        report: report.report,
      },
      null,
      2
    )}\n`
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
