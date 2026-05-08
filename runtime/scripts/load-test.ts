import { RelayEngine } from "../src/core/relay-engine.js";
import { loadConfig } from "../src/config.js";

const engine = new RelayEngine(loadConfig());
const start = Date.now();
const total = 10000;

for (let index = 0; index < total; index += 1) {
  engine.ingest({
    source: index % 2 === 0 ? "miniapp" : "admin-web",
    level: index % 50 === 0 ? "error" : "info",
    message: index % 50 === 0 ? `critical failure ${index}` : `heartbeat ${index}`,
    route: index % 2 === 0 ? "/pages/index" : "/dashboard",
  });
}

const snapshot = engine.listIncidents(60, 20);
const elapsed = Date.now() - start;
console.log(
  JSON.stringify(
    {
      totalInput: total,
      elapsedMs: elapsed,
      incidents: snapshot.total,
      topCount: snapshot.incidents[0] ? snapshot.incidents[0].count : 0,
    },
    null,
    2
  )
);
