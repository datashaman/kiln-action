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
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Shared utility to invoke Claude Code via the CLI.
 *
 * This is Kiln's integration layer for AI stages. All stages use this
 * function to interact with Claude, ensuring a consistent pattern for
 * prompt delivery, output capture, timeout handling, error surfacing,
 * and API-key security.
 *
 * Mirrors the interface of anthropics/claude-code-action@v1:
 * - Accepts a prompt string (equivalent to direct_prompt)
 * - Passes the API key via environment variable (never logged)
 * - Hard-coded 30-minute default timeout (matching v1)
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

  // --print mode = read-only (no file edits); omit for edit mode
  const command = allowEdits ? "claude" : "claude --print";

  try {
    // Pass prompt via stdin to avoid shell escaping issues with complex input
    const output = execSync(command, {
      input: prompt,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: anthropicKey,
      },
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: "utf-8",
    });

    return { output: output.trim(), success: true };
  } catch (error) {
    const isTimeout =
      error instanceof Error && "killed" in error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
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
 * Convenience wrapper: invoke Claude in read-only mode (--print).
 * Used by triage and review stages.
 */
export function runClaude(
  prompt: string,
  options: { anthropicKey: string; timeoutMinutes?: number },
): string {
  const { anthropicKey, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES } = options;
  const timeoutMs = timeoutMinutes * 60 * 1000;

  try {
    const output = execSync("claude --print", {
      input: prompt,
      env: { ...process.env, ANTHROPIC_API_KEY: anthropicKey },
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
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
 * Convenience wrapper: invoke Claude in edit mode (can modify files).
 * Used by specify, implement, and fix stages.
 */
export function runClaudeEdit(
  prompt: string,
  options: { anthropicKey: string; timeoutMinutes?: number },
): string {
  const { anthropicKey, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES } = options;
  const timeoutMs = timeoutMinutes * 60 * 1000;

  try {
    const output = execSync("claude", {
      input: prompt,
      env: { ...process.env, ANTHROPIC_API_KEY: anthropicKey },
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: "utf-8",
    });
    return output.trim();
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
