import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AgentConfig {
  apiKey: string;
  serverUrl: string;
  schedulerPaused?: boolean;
}

interface StoredAgentConfig {
  apiKey?: string;
  serverUrl?: string;
  schedulerPaused?: boolean;
}

const CONFIG_DIR = join(homedir(), ".auto-scraper");
const CONFIG_FILE = join(CONFIG_DIR, "agent.json");

function readStoredConfig(): StoredAgentConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as StoredAgentConfig;
  } catch {
    return {};
  }
}

function writeStoredConfig(config: StoredAgentConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

export function readConfig(): AgentConfig | null {
  const parsed = readStoredConfig();
  if (parsed.apiKey && parsed.serverUrl) {
    return {
      apiKey: parsed.apiKey,
      serverUrl: parsed.serverUrl,
      schedulerPaused: parsed.schedulerPaused,
    };
  }
  return null;
}

export function updateConfig(patch: Partial<AgentConfig>): void {
  const nextConfig = { ...readStoredConfig(), ...patch };
  writeStoredConfig(nextConfig);
}

export function writeConfig(config: AgentConfig): void {
  updateConfig(config);
}
