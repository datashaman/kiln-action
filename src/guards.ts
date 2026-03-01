import * as core from "@actions/core";
import { Octokit } from "./types";
import { Context } from "@actions/github/lib/context";

/**
 * Check if the event was triggered by a bot or GitHub Actions itself.
 * Prevents infinite loops where Kiln's own label changes re-trigger stages.
 */
export function isBotActor(context: Context): boolean {
  const sender = context.payload.sender as
    | { login?: string; type?: string }
    | undefined;
  if (!sender) return false;
  return (
    sender.type === "Bot" ||
    sender.login === "github-actions[bot]" ||
    sender.login === "kiln[bot]"
  );
}

/**
 * Post a branded error comment on the relevant issue or PR.
 * Best-effort — failures are logged but not thrown.
 *
 * AC2: Error comments are branded "🔥 **Kiln** — Error in {stage}: {message}"
 * AC5: Timeout errors include a specific timeout indicator
 */
export async function postStageError(
  octokit: Octokit,
  context: Context,
  stage: string,
  message: string,
): Promise<void> {
  const issueNumber =
    (context.payload.issue?.number as number | undefined) ??
    (context.payload.pull_request?.number as number | undefined);
  if (!issueNumber) return;

  const isTimeout = /timed?\s*out/i.test(message);
  const body = isTimeout
    ? `🔥 **Kiln** — Error in ${stage}: ⏱️ ${message}\n\nThe stage exceeded the configured timeout. Consider increasing \`timeout_minutes\` or breaking the task into smaller steps.`
    : `🔥 **Kiln** — Error in ${stage}: ${message}`;

  try {
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: issueNumber,
      body,
    });
  } catch {
    core.warning("Failed to post stage error comment");
  }
}
