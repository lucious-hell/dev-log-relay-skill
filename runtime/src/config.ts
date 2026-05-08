export interface RelayConfig {
  port: number;
  host: string;
  maxBufferedEvents: number;
  maxPendingEvents: number;
  contextWindowSize: number;
  includeDebug: boolean;
  artifactDir: string;
  projectMemoryDir: string;
}

function intFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadConfig(): RelayConfig {
  return {
    port: intFromEnv("DEV_LOG_RELAY_PORT", 5077),
    host: process.env.DEV_LOG_RELAY_HOST || "127.0.0.1",
    maxBufferedEvents: intFromEnv("DEV_LOG_RELAY_MAX_EVENTS", 50000),
    maxPendingEvents: intFromEnv("DEV_LOG_RELAY_MAX_PENDING", 20000),
    contextWindowSize: intFromEnv("DEV_LOG_RELAY_CONTEXT_WINDOW", 50),
    includeDebug: String(process.env.DEV_LOG_RELAY_INCLUDE_DEBUG || "").trim() === "1",
    artifactDir: process.env.DEV_LOG_RELAY_ARTIFACT_DIR || "artifacts",
    projectMemoryDir: process.env.DEV_LOG_RELAY_PROJECT_MEMORY_DIR || "project-memory",
  };
}
