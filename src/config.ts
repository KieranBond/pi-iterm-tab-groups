import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface SemanticConfig {
  enabled: boolean;
  provider: string;
  model: string;
  debounceMs: number;
  cooldownMs: number;
  maxCallsPerHour: number;
}

export interface TabGroupsConfig {
  semantic: SemanticConfig;
}

export const DEFAULT_CONFIG: TabGroupsConfig = {
  semantic: {
    enabled: false,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    debounceMs: 30_000,
    cooldownMs: 5 * 60_000,
    maxCallsPerHour: 6,
  },
};

export function configPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_DIR)
    : path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "iterm-tab-groups", "config.json");
}

export function loadConfig(filePath = configPath(), onError?: (error: Error) => void): TabGroupsConfig {
  if (!existsSync(filePath)) return structuredClone(DEFAULT_CONFIG);
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { semantic?: Partial<SemanticConfig> };
    const semantic = { ...DEFAULT_CONFIG.semantic, ...(parsed.semantic ?? {}) };
    if (
      typeof semantic.enabled !== "boolean"
      || typeof semantic.provider !== "string"
      || !semantic.provider
      || typeof semantic.model !== "string"
      || !semantic.model
      || !Number.isSafeInteger(semantic.debounceMs)
      || semantic.debounceMs < 0
      || !Number.isSafeInteger(semantic.cooldownMs)
      || semantic.cooldownMs < 0
      || !Number.isSafeInteger(semantic.maxCallsPerHour)
      || semantic.maxCallsPerHour < 1
      || semantic.maxCallsPerHour > 60
    ) {
      throw new Error("Invalid semantic configuration");
    }
    return { semantic };
  } catch {
    onError?.(new Error(`Invalid tab grouping configuration at ${filePath}; semantic grouping remains disabled`));
    return structuredClone(DEFAULT_CONFIG);
  }
}
