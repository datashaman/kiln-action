import * as core from "@actions/core";
import * as fs from "fs";
import * as yaml from "js-yaml";
import { KilnConfig } from "./types";

const DEFAULTS: KilnConfig = {
  protected_paths: [".github/", ".env", "CLAUDE.md", ".kiln/"],
  human_review: {
    spec: "required",
    implementation: "auto",
  },
  auto_merge: true,
  timeout_minutes: 30,
  labels: {
    prefix: "kiln",
  },
  agents: {
    triage: { enabled: true },
    spec: { enabled: true },
    implement: { enabled: true, run_tests: true, run_lint: true },
    review: { enabled: true, auto_approve: false },
    fix: { enabled: true, max_iterations: 3 },
  },
};

export async function loadConfig(configPath: string): Promise<KilnConfig> {
  if (!fs.existsSync(configPath)) {
    core.info(`No config found at ${configPath}, using defaults.`);
    return DEFAULTS;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const userConfig = (yaml.load(raw) || {}) as Record<string, unknown>;
    return deepMerge(
      DEFAULTS as unknown as Record<string, unknown>,
      userConfig,
    ) as unknown as KilnConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to parse config at ${configPath}: ${message}`);
    return DEFAULTS;
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
