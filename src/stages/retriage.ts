import * as core from "@actions/core";
import { runClaude } from "../claude";
import { transitionLabel } from "../labels";
import { KilnContext, StageResult } from "../types";
import { TriageResult } from "./triage";

export default async function retriage(
  ctx: KilnContext,
): Promise<StageResult> {
  const { octokit, context, config, anthropicKey, timeoutMinutes } = ctx;
  const issue = context.payload.issue!;
  const comment = context.payload.comment;
  const prefix = config.labels?.prefix || "kiln";

  core.info(`🔥 Re-triage — Issue #${issue.number}: ${issue.title}`);

  // AC: Ignore comments from bots/actions (prevents infinite loops)
  const sender = comment?.user?.login as string | undefined;
  const senderType = comment?.user?.type as string | undefined;
  if (senderType === "Bot" || sender === "github-actions[bot]") {
    core.info(`🔥 Re-triage — Ignoring bot comment from ${sender}`);
    return { status: "success", nextStage: "waiting-for-info" };
  }

  // AC: Fetch all comments for the issue
  const { data: comments } = await octokit.rest.issues.listComments({
    ...context.repo,
    issue_number: issue.number,
    per_page: 100,
  });

  const commentThread = comments
    .map(
      (c: { user: { login: string } | null; body?: string }) =>
        `**@${c.user?.login}:** ${c.body || ""}`,
    )
    .join("\n\n");

  const prompt = `You are the Kiln triage agent performing a RE-TRIAGE. The issue was previously flagged as needing more information. The author (or others) have now commented. Re-evaluate whether the issue is now clear enough to write a technical spec.

**Issue #${issue.number}**
**Title:** ${issue.title}
**Body:** ${issue.body || "(empty)"}

**Comments:**
${commentThread}

Re-assess:
1. Is there now enough information to write a technical spec? (clear_enough: true/false)
2. Write a brief comment for the issue author.

If NOT clear enough, your comment should politely explain what specific information is still missing.
If clear enough, your comment should confirm your understanding of what needs to be done.

Respond with ONLY this JSON:
\`\`\`json
{
  "type": "feature",
  "complexity": "m",
  "clear_enough": true,
  "comment": "Your comment here",
  "labels": []
}
\`\`\``;

  const output = runClaude(prompt, { anthropicKey, timeoutMinutes });

  let result: TriageResult;
  try {
    const jsonMatch =
      output.match(/```json\s*([\s\S]*?)\s*```/) ||
      output.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : output;
    result = JSON.parse(jsonStr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to parse re-triage response: ${message}`);
    core.warning(`Raw output: ${output}`);
    result = {
      type: "feature",
      complexity: "m",
      clear_enough: true,
      comment: "🔥 **Kiln** — Re-triaged. Moving to specification.",
      labels: [],
    };
  }

  // Post branded re-triage comment
  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: issue.number,
    body: `🔥 **Kiln Re-triage**\n\n${result.comment}`,
  });

  if (result.clear_enough) {
    // AC: Remove kiln:needs-info, apply kiln:specifying
    await transitionLabel(
      octokit,
      context,
      issue.number,
      "needs-info",
      "specifying",
      prefix,
    );
    return { status: "success", nextStage: "specify" };
  }

  // AC: Still unclear — keep kiln:needs-info, post follow-up request
  return { status: "success", nextStage: "waiting-for-info" };
}
