import { execSync } from "child_process";
import * as core from "@actions/core";

export interface ClaudeOptions {
  anthropicKey: string;
  timeoutMinutes?: number;
}

/**
 * Run Claude Code CLI in read-only mode (no file edits).
 * Used for triage and review stages.
 */
export function runClaude(prompt: string, options: ClaudeOptions): string {
  const { anthropicKey, timeoutMinutes = 30 } = options;
  const timeoutMs = timeoutMinutes * 60 * 1000;

  try {
    const output = execSync(`claude --print "${escapeShell(prompt)}"`, {
      env: { ...process.env, ANTHROPIC_API_KEY: anthropicKey },
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
    });
    return output.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.error(`Claude CLI failed: ${message}`);
    throw error;
  }
}

/**
 * Run Claude Code CLI in edit mode (can modify files).
 * Used for specify, implement, and fix stages.
 */
export function runClaudeEdit(prompt: string, options: ClaudeOptions): string {
  const { anthropicKey, timeoutMinutes = 30 } = options;
  const timeoutMs = timeoutMinutes * 60 * 1000;

  try {
    const output = execSync(`claude "${escapeShell(prompt)}"`, {
      env: { ...process.env, ANTHROPIC_API_KEY: anthropicKey },
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
    });
    return output.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.error(`Claude CLI (edit) failed: ${message}`);
    throw error;
  }
}

function escapeShell(str: string): string {
  return str.replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}
