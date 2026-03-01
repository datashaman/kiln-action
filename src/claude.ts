import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
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

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const EDIT_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

/**
 * Call the Claude Agent SDK and extract the final result text.
 */
async function extractResult(
  prompt: string,
  anthropicKey: string,
  timeoutMs: number,
  allowEdits: boolean,
): Promise<string> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const stderrChunks: string[] = [];

  try {
    let resultMessage: SDKResultMessage | undefined;

    const stream = query({
      prompt,
      options: {
        tools: allowEdits ? EDIT_TOOLS : READ_ONLY_TOOLS,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        abortController,
        env: { ...process.env, ANTHROPIC_API_KEY: anthropicKey },
        stderr: (data: string) => {
          stderrChunks.push(data);
          core.warning(`Claude SDK stderr: ${data.trimEnd()}`);
        },
      },
    });

    try {
      for await (const message of stream) {
        if (message.type === "result") {
          resultMessage = message as SDKResultMessage;
        }
      }
    } catch (streamError) {
      // Re-throw AbortError as-is for timeout detection
      if (streamError instanceof Error && streamError.name === "AbortError") {
        throw streamError;
      }
      // Enrich other SDK process errors with captured stderr
      const stderr = stderrChunks.join("");
      const baseMsg = streamError instanceof Error ? streamError.message : String(streamError);
      throw new Error(`${baseMsg}${stderr ? `\nstderr: ${stderr}` : ""}`);
    }

    if (!resultMessage) {
      const stderr = stderrChunks.join("");
      throw new Error(
        `No result received from Claude Agent SDK${stderr ? `\nstderr: ${stderr}` : ""}`,
      );
    }

    if (resultMessage.subtype !== "success") {
      const errorResult = resultMessage as SDKResultMessage & { errors?: string[] };
      const stderr = stderrChunks.join("");
      const baseMsg = errorResult.errors?.join("; ") || `Claude SDK error: ${resultMessage.subtype}`;
      throw new Error(`${baseMsg}${stderr ? `\nstderr: ${stderr}` : ""}`);
    }

    return resultMessage.result.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared utility to invoke Claude Code via the Agent SDK.
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
    const output = await extractResult(prompt, anthropicKey, timeoutMs, allowEdits);
    return { output, success: true };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
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
    return await extractResult(prompt, anthropicKey, timeoutMs, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.error(`Claude SDK failed: ${message}`);
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
    return await extractResult(prompt, anthropicKey, timeoutMs, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.error(`Claude SDK (edit) failed: ${message}`);
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
