import { loadConfig } from "./config.js";
import { createRelayServer } from "./server/app.js";

async function main() {
  const config = loadConfig();
  const server = createRelayServer(config);
  await server.listen({
    host: config.host,
    port: config.port,
  });
}

main().catch((error) => {
  console.error("[dev-log-relay] fatal error:", error);
  process.exit(1);
});
