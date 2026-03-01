import { execSync } from "child_process";
import * as core from "@actions/core";
import { Octokit } from "./types";
import { Context } from "@actions/github/lib/context";

export interface ClaudeConfig {
  /** Anthropic API key (required) */
  anthropicKey: string;
  /** Timeout in minutes (default: 30, matching claude-code-action v1) */
  timeoutMinutes?: number;
  /** Whether Claude can edit files (default: false = read-only / --print mode) */
  allowEdits?: boolean;
  /** Octokit instance for posting error comments (optional) */
  octokit?: Octokit;
  /** GitHub Actions context for resolving issue/PR numbers (optional) */
  context?: Context;
}

export interface ClaudeResult {
  /** The raw text output from Claude */
  output: string;
  /** Whether the invocation succeeded */
  success: boolean;
  /** Error message if the invocation failed */
  error?: string;
}

const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * Call the Claude Code CLI and return its stdout.
 *
 * - Read-only mode: `claude --print --dangerously-skip-permissions`
 * - Edit mode: `claude --dangerously-skip-permissions`
 *
 * The prompt is passed via stdin; the API key via ANTHROPIC_API_KEY env var.
 */
function execClaude(
  prompt: string,
  anthropicKey: string,
  timeoutMs: number,
  allowEdits: boolean,
): string {
  const args = allowEdits
    ? ["claude", "--dangerously-skip-permissions"]
    : ["claude", "--print", "--dangerously-skip-permissions"];

  const result = execSync(args.join(" "), {
    input: prompt,
    timeout: timeoutMs,
    encoding: "utf-8",
    env: { ...process.env, ANTHROPIC_API_KEY: anthropicKey },
    maxBuffer: 50 * 1024 * 1024, // 50 MB
    stdio: ["pipe", "pipe", "pipe"],
  });

  return result.trim();
}

/**
 * Shared utility to invoke Claude Code via the CLI.
 *
 * This is Kiln's integration layer for AI stages. All stages use this
 * function to interact with Claude, ensuring a consistent pattern for
 * prompt delivery, output capture, timeout handling, error surfacing,
 * and API-key security.
 */
export async function invokeClaude(
  prompt: string,
  config: ClaudeConfig,
): Promise<ClaudeResult> {
  const {
    anthropicKey,
    timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
    allowEdits = false,
    octokit,
    context,
  } = config;

  const timeoutMs = timeoutMinutes * 60 * 1000;

  try {
    const output = execClaude(prompt, anthropicKey, timeoutMs, allowEdits);
    return { output, success: true };
  } catch (error) {
    const isTimeout =
      error instanceof Error && (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const errorMessage = isTimeout
      ? `Claude Code timed out after ${timeoutMinutes} minutes`
      : error instanceof Error
        ? error.message
        : String(error);

    core.error(`Claude Code invocation failed: ${errorMessage}`);

    // Surface the error as a comment on the relevant issue/PR when possible
    await postErrorComment(errorMessage, octokit, context);

    return { output: "", success: false, error: errorMessage };
  }
}

/**
 * Convenience wrapper: invoke Claude in read-only mode.
 * Used by triage and review stages.
 */
export async function runClaude(
  prompt: string,
  options: { anthropicKey: string; timeoutMinutes?: number },
): Promise<string> {
  const { anthropicKey, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES } = options;
  const timeoutMs = timeoutMinutes * 60 * 1000;

  try {
    return execClaude(prompt, anthropicKey, timeoutMs, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.error(`Claude CLI failed: ${message}`);
    throw error;
  }
}

/**
 * Convenience wrapper: invoke Claude in edit mode (can modify files).
 * Used by specify, implement, and fix stages.
 */
export async function runClaudeEdit(
  prompt: string,
  options: { anthropicKey: string; timeoutMinutes?: number },
): Promise<string> {
  const { anthropicKey, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES } = options;
  const timeoutMs = timeoutMinutes * 60 * 1000;

  try {
    return execClaude(prompt, anthropicKey, timeoutMs, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.error(`Claude CLI (edit) failed: ${message}`);
    throw error;
  }
}

/**
 * Post an error comment on the relevant issue or PR.
 * Best-effort — failures are logged but not thrown.
 */
async function postErrorComment(
  errorMessage: string,
  octokit?: Octokit,
  context?: Context,
): Promise<void> {
  if (!octokit || !context) return;

  const issueNumber = resolveCommentTarget(context);
  if (!issueNumber) return;

  // Sanitize: strip the API key from the error message if it leaked
  const sanitized = sanitizeOutput(
    errorMessage,
    process.env.ANTHROPIC_API_KEY,
  );

  try {
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: issueNumber,
      body: `🔥 **Kiln** — Claude Code error: ${sanitized}`,
    });
  } catch (commentError) {
    const msg =
      commentError instanceof Error
        ? commentError.message
        : String(commentError);
    core.warning(`Failed to post error comment: ${msg}`);
  }
}

/**
 * Determine the issue or PR number to post comments on.
 */
function resolveCommentTarget(context: Context): number | undefined {
  const payload = context.payload;

  if (payload.issue) {
    return (payload.issue as { number: number }).number;
  }
  if (payload.pull_request) {
    return (payload.pull_request as { number: number }).number;
  }
  return undefined;
}

/**
 * Remove any occurrence of the API key from output strings.
 */
function sanitizeOutput(text: string, apiKey?: string): string {
  if (!apiKey) return text;
  return text.replace(new RegExp(escapeRegExp(apiKey), "g"), "[REDACTED]");
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
