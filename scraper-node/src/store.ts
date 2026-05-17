import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AgentConfig {
  apiKey: string;
  serverUrl: string;
  schedulerPaused?: boolean;
  agentId?: string;
  agentSecret?: string;
  credentialServerUrl?: string;
  credentialApiKey?: string;
}

interface StoredAgentConfig {
  apiKey?: string;
  serverUrl?: string;
  schedulerPaused?: boolean;
  agentId?: string;
  agentSecret?: string;
  credentialServerUrl?: string;
  credentialApiKey?: string;
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
      agentId: parsed.agentId,
      agentSecret: parsed.agentSecret,
      credentialServerUrl: parsed.credentialServerUrl,
      credentialApiKey: parsed.credentialApiKey,
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

export function hasUsableAgentCredentials(config: AgentConfig): config is AgentConfig & {
  agentId: string;
  agentSecret: string;
} {
  return (
    typeof config.agentId === "string" &&
    config.agentId.length > 0 &&
    typeof config.agentSecret === "string" &&
    config.agentSecret.length > 0 &&
    config.credentialServerUrl === config.serverUrl &&
    config.credentialApiKey === config.apiKey
  );
}
