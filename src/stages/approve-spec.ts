import * as core from "@actions/core";
import { transitionLabel } from "../labels";
import { KilnContext, StageResult } from "../types";

export default async function approveSpec(
  ctx: KilnContext,
): Promise<StageResult> {
  const { octokit, context, config } = ctx;
  const pr = context.payload.pull_request!;
  const prefix = config.labels?.prefix || "kiln";

  core.info(`🔥 Approve Spec — PR #${pr.number}: ${pr.title}`);

  try {
    await octokit.rest.pulls.merge({
      ...context.repo,
      pull_number: pr.number,
      merge_method: "squash",
      commit_title: `${pr.title} (#${pr.number})`,
    });
    core.info(`Spec PR #${pr.number} merged.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Failed to merge spec PR: ${message}`);
    return { status: "error" };
  }

  // Extract issue number from branch name (kiln/spec/issue-{number})
  const branchName = pr.head?.ref as string | undefined;
  const branchMatch = branchName?.match(/^kiln\/spec\/issue-(\d+)$/);

  // Fallback to PR body if branch name doesn't match
  const bodyMatch = !branchMatch
    ? (pr.body as string | undefined)?.match(/Tracking issue: #(\d+)/)
    : null;

  const issueMatch = branchMatch || bodyMatch;
  if (!issueMatch) {
    core.warning("Could not find linked issue number in branch name or PR body.");
    return { status: "success" };
  }

  const issueNumber = parseInt(issueMatch[1], 10);

  await transitionLabel(
    octokit,
    context,
    issueNumber,
    "spec-review",
    "implementing",
    prefix,
  );

  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: issueNumber,
    body: `🔨 **Kiln** — Spec approved and merged. Starting implementation.`,
  });

  return { status: "success", nextStage: "implement" };
}
