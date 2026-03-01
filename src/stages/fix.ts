import * as core from "@actions/core";
import { execSync } from "child_process";
import { runClaudeEdit, runClaude } from "../claude";
import { KilnContext, StageResult } from "../types";

export default async function fix(ctx: KilnContext): Promise<StageResult> {
  const { octokit, context, config, anthropicKey, timeoutMinutes } = ctx;
  const pr = context.payload.pull_request!;
  const maxIterations = config.agents?.fix?.max_iterations || 3;

  core.info(`🔥 Fix — PR #${pr.number}: addressing review feedback`);

  const { data: commits } = await octokit.rest.pulls.listCommits({
    ...context.repo,
    pull_number: pr.number,
  });
  const fixCount = commits.filter((c) =>
    c.commit.message.includes("kiln-fix"),
  ).length;

  if (fixCount >= maxIterations) {
    core.warning(
      `🔥 Fix limit reached (${maxIterations} iterations). Flagging for human review.`,
    );
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: pr.number,
      body: `⚠️ **Kiln** — Fix agent has reached the maximum of ${maxIterations} iterations. A human needs to step in.\n\ncc @${context.repo.owner}`,
    });
    await octokit.rest.issues.addLabels({
      ...context.repo,
      issue_number: pr.number,
      labels: ["needs-human-review"],
    });
    return { status: "max-iterations" };
  }

  const { data: reviews } = await octokit.rest.pulls.listReviews({
    ...context.repo,
    pull_number: pr.number,
  });

  const { data: reviewComments } =
    await octokit.rest.pulls.listReviewComments({
      ...context.repo,
      pull_number: pr.number,
    });

  const feedbackItems: string[] = [];

  for (const review of reviews) {
    if (review.state === "CHANGES_REQUESTED" && review.body) {
      feedbackItems.push(`**Review summary:** ${review.body}`);
    }
  }

  for (const comment of reviewComments) {
    feedbackItems.push(
      `**${comment.path}:${comment.line || comment.original_line}** — ${comment.body}`,
    );
  }

  const feedback = feedbackItems.join("\n\n");

  execSync(`git fetch origin ${pr.head.ref}`);
  execSync(`git checkout ${pr.head.ref}`);
  execSync('git config user.name "kiln[bot]"');
  execSync('git config user.email "kiln[bot]@users.noreply.github.com"');

  const prompt = `You are the Kiln fix agent. A code review requested changes on this PR.

**PR #${pr.number}:** ${pr.title}

**Review feedback to address:**

${feedback}

Read each piece of feedback carefully and fix every issue:
- Fix code issues mentioned in reviews
- Add missing tests if requested
- Improve error handling if flagged
- Address all concerns, not just some

After fixing, commit with message: "fix: address review feedback (kiln-fix #${fixCount + 1})"
Then push to the current branch.`;

  runClaudeEdit(prompt, { anthropicKey, timeoutMinutes });

  try {
    execSync(`git push origin ${pr.head.ref}`);
  } catch {
    // Claude may have already pushed
  }

  // AC7: Reply to each review comment explaining the changes made
  for (const comment of reviewComments) {
    try {
      const replyPrompt = `A code review comment was left on ${comment.path}:${comment.line || comment.original_line}:

"${comment.body}"

The fix agent has addressed this feedback. Write a brief, specific reply (1-3 sentences) explaining what was changed to address this comment. Be concrete about the fix, not vague. Do NOT use markdown code blocks. Just output the reply text directly.`;

      const reply = runClaude(replyPrompt, { anthropicKey, timeoutMinutes: 2 });

      await octokit.rest.pulls.createReplyForReviewComment({
        ...context.repo,
        pull_number: pr.number,
        comment_id: comment.id,
        body: `🔧 **Kiln** — ${reply}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(
        `Failed to reply to review comment ${comment.id}: ${message}`,
      );
    }
  }

  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: pr.number,
    body: `🔧 **Kiln** — Review feedback addressed (iteration ${fixCount + 1}/${maxIterations}). Ready for re-review.`,
  });

  return { status: "success", iteration: fixCount + 1 };
}
