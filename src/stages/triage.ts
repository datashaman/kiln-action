import * as core from "@actions/core";
import { runClaude } from "../claude";
import { transitionLabel } from "../labels";
import { KilnContext, StageResult } from "../types";

export interface TriageResult {
  type: string;
  complexity: string;
  clear_enough: boolean;
  comment: string;
  labels: string[];
}

export default async function triage(ctx: KilnContext): Promise<StageResult> {
  const { octokit, context, config, anthropicKey, timeoutMinutes } = ctx;
  const issue = context.payload.issue!;
  const prefix = config.labels?.prefix || "kiln";

  core.info(`🔥 Triage — Issue #${issue.number}: ${issue.title}`);

  const prompt = `You are the Kiln triage agent. Analyze this issue and respond with ONLY a JSON block.

**Issue #${issue.number}**
**Title:** ${issue.title}
**Body:** ${issue.body || "(empty)"}

Classify and assess:
1. Type: feature, bug, improvement, or chore
2. Complexity: xs, s, m, l, xl
3. Is there enough information to write a technical spec? (clear_enough: true/false)
4. Write a brief comment for the issue author.
5. Suggest any additional labels (beyond type and size) that should be applied.

If NOT clear enough, your comment should politely ask for the specific missing information.
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

  const output = await runClaude(prompt, { anthropicKey, timeoutMinutes });

  let result: TriageResult;
  try {
    const jsonMatch =
      output.match(/```json\s*([\s\S]*?)\s*```/) ||
      output.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : output;
    result = JSON.parse(jsonStr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to parse triage response: ${message}`);
    core.warning(`Raw output: ${output}`);
    result = {
      type: "feature",
      complexity: "m",
      clear_enough: true,
      comment: "🔥 **Kiln** — Triaged. Moving to specification.",
      labels: [],
    };
  }

  // Post branded triage comment
  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: issue.number,
    body: `🔥 **Kiln Triage**\n\n${result.comment}\n\n---\n*Type: \`${result.type}\` · Size: \`${result.complexity}\`*`,
  });

  // Apply type and size labels, plus any additional labels from Claude
  const labels = [
    `type:${result.type}`,
    `size:${result.complexity}`,
    ...(result.labels || []),
  ];
  await octokit.rest.issues.addLabels({
    ...context.repo,
    issue_number: issue.number,
    labels,
  });

  if (result.clear_enough) {
    // Clear enough → move to specifying
    await transitionLabel(
      octokit,
      context,
      issue.number,
      null,
      "specifying",
      prefix,
    );
    return { status: "success", nextStage: "specify" };
  }

  // Not clear enough → apply needs-info label with proper prefix
  await octokit.rest.issues.addLabels({
    ...context.repo,
    issue_number: issue.number,
    labels: [`${prefix}:needs-info`],
  });

  return { status: "success", nextStage: "waiting-for-info" };
}
