import * as core from "@actions/core";
import { transitionLabel } from "../labels";
import { KilnContext, StageResult } from "../types";

export default async function ship(ctx: KilnContext): Promise<StageResult> {
  const { octokit, context, config } = ctx;
  const prefix = config.labels?.prefix || "kiln";

  // Resolve PR from payload — pull_request_review has it directly,
  // check_suite.completed needs to look it up from associated PRs.
  let pr = context.payload.pull_request;
  if (!pr && context.eventName === "check_suite") {
    const suitePrs =
      (context.payload.check_suite?.pull_requests as Array<{ number: number }>) || [];
    if (suitePrs.length > 0) {
      const { data: fullPr } = await octokit.rest.pulls.get({
        ...context.repo,
        pull_number: suitePrs[0].number,
      });
      pr = fullPr as unknown as typeof pr;
    }
  }

  if (!pr) {
    core.info("🔥 Ship — No PR in payload, skipping.");
    return { status: "skipped" };
  }

  // For check_suite events, verify the PR has the implementation label
  const prLabels = ((pr.labels as Array<{ name: string }>) || []).map(
    (l) => l.name,
  );
  if (!prLabels.some((l) => l.endsWith(":implementation"))) {
    core.info("🔥 Ship — PR does not have implementation label, skipping.");
    return { status: "skipped" };
  }

  core.info(`🔥 Ship — Checking if PR #${pr.number} is ready to merge`);

  const { data: reviews } = await octokit.rest.pulls.listReviews({
    ...context.repo,
    pull_number: pr.number,
  });

  const isApproved = reviews.some((r) => r.state === "APPROVED");
  if (!isApproved) {
    core.info("🔥 Ship — PR not yet approved. Skipping.");
    return { status: "skipped", reason: "not-approved" };
  }

  const { data: checks } = await octokit.rest.checks.listForRef({
    ...context.repo,
    ref: pr.head.sha,
  });

  const ciPassing = checks.check_runs
    .filter((c) => c.name !== "kiln")
    .every(
      (c) => c.conclusion === "success" || c.conclusion === "skipped",
    );

  if (!ciPassing) {
    core.info(
      "🔥 Ship — CI not yet green. Will retry when checks complete.",
    );
    return { status: "skipped", reason: "ci-pending" };
  }

  if (!config.auto_merge) {
    core.info(
      "🔥 Ship — Auto-merge disabled. PR is approved and ready for manual merge.",
    );
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: pr.number,
      body: "✅ **Kiln** — PR approved and CI green. Auto-merge is disabled — merge when ready.",
    });
    return { status: "success", reason: "auto-merge-disabled" };
  }

  core.info(`🔥 Ship — Merging PR #${pr.number}`);

  try {
    await octokit.rest.pulls.merge({
      ...context.repo,
      pull_number: pr.number,
      merge_method: "squash",
      commit_title: `${pr.title} (#${pr.number})`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Merge failed: ${message}`);
    return { status: "error", reason: "merge-failed" };
  }

  const issueMatch = (pr.body as string | undefined)?.match(/Closes #(\d+)/i);
  if (issueMatch) {
    const issueNumber = parseInt(issueMatch[1], 10);

    await transitionLabel(
      octokit,
      context,
      issueNumber,
      "in-review",
      "done",
      prefix,
    );

    await octokit.rest.issues.update({
      ...context.repo,
      issue_number: issueNumber,
      state: "closed",
    });

    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: issueNumber,
      body: [
        "🔥 **Kiln** — Shipped!",
        "",
        `Implementation merged via #${pr.number}.`,
        "",
        "*Fired in the Kiln.* 🏷️",
      ].join("\n"),
    });

    core.info(`🔥 Ship — Issue #${issueNumber} closed.`);
  }

  core.info("🔥 Shipped! 🚀");
  return { status: "success" };
}
