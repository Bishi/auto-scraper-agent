import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AgentConfig {
  apiKey: string;
  serverUrl: string;
}

const CONFIG_DIR = join(homedir(), ".auto-scraper");
const CONFIG_FILE = join(CONFIG_DIR, "agent.json");

export function readConfig(): AgentConfig | null {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    if (parsed.apiKey && parsed.serverUrl) {
      return { apiKey: parsed.apiKey, serverUrl: parsed.serverUrl };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeConfig(config: AgentConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}
