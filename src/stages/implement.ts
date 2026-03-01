import * as core from "@actions/core";
import * as fs from "fs";
import { execSync } from "child_process";
import { runClaudeEdit } from "../claude";
import { transitionLabel } from "../labels";
import { KilnContext, StageResult } from "../types";

export default async function implement(
  ctx: KilnContext,
): Promise<StageResult> {
  const { octokit, context, config, anthropicKey, timeoutMinutes } = ctx;
  const issue = context.payload.issue!;
  const prefix = config.labels?.prefix || "kiln";
  const issueNum = issue.number;
  const branchName = `kiln/impl/issue-${issueNum}`;
  const specPath = `specs/issue-${issueNum}.md`;

  core.info(`🔥 Implement — Issue #${issueNum}: ${issue.title}`);

  // AC5: If an implementation PR already exists for this issue, don't create a duplicate
  const { data: existingPRs } = await octokit.rest.pulls.list({
    ...context.repo,
    head: `${context.repo.owner}:${branchName}`,
    state: "open",
  });
  if (existingPRs.length > 0) {
    core.info(
      `🔥 Implement — Implementation PR already exists for issue #${issueNum}: #${existingPRs[0].number}. Skipping.`,
    );
    return { status: "skipped", reason: "duplicate", prNumber: existingPRs[0].number };
  }

  execSync(
    "git fetch origin main && git checkout main && git pull origin main",
  );

  if (!fs.existsSync(specPath)) {
    const reason = `Spec not found at ${specPath}. Was the spec PR merged?`;
    core.setFailed(reason);
    return { status: "error", reason };
  }

  execSync('git config user.name "kiln[bot]"');
  execSync('git config user.email "kiln[bot]@users.noreply.github.com"');
  execSync(`git checkout -b ${branchName}`);

  const protectedPaths = config.protected_paths || [
    ".github/",
    ".env",
    "CLAUDE.md",
  ];
  const protectedList = protectedPaths.map((p) => `- ${p}`).join("\n");

  const prompt = `You are the Kiln implementation agent. You write production-quality code.

**Issue #${issueNum}**
**Title:** ${issue.title}

INSTRUCTIONS:
1. Read the specification at: ${specPath}
2. Read the existing codebase to understand conventions, patterns, and style
3. Implement EVERYTHING described in the spec

RULES:
- Follow existing project conventions exactly (naming, structure, patterns)
- Write ALL tests described in the spec's Test Plan
- Run the test suite and fix any failures
- Run linting/formatting and fix any issues
- Use conventional commits: feat:, fix:, test:, refactor:, etc.
- Keep commits atomic and well-described
- Each commit message should reference #${issueNum}

DO NOT modify these protected paths:
${protectedList}

DO NOT:
- Change anything outside the scope of the spec
- Skip writing tests
- Leave TODO or FIXME comments — implement everything
- Modify unrelated files

After implementing, commit all changes and push to the current branch.`;

  await runClaudeEdit(prompt, { anthropicKey, timeoutMinutes });

  try {
    execSync(`git push origin ${branchName} --force`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(
      `Push failed (Claude may have already pushed): ${message}`,
    );
  }

  const { data: pr } = await octokit.rest.pulls.create({
    ...context.repo,
    title: `🔨 Kiln Impl: ${issue.title}`,
    body: [
      `## Implementation for #${issueNum}`,
      "",
      `📋 Spec: \`${specPath}\``,
      "",
      "🔥 *Fired in the Kiln*",
      "",
      "### Checklist",
      "- [ ] All acceptance criteria from spec are met",
      "- [ ] Tests passing",
      "- [ ] Lint passing",
      "- [ ] No changes outside spec scope",
      "",
      `Closes #${issueNum}`,
    ].join("\n"),
    head: branchName,
    base: "main",
  });

  await octokit.rest.issues.addLabels({
    ...context.repo,
    issue_number: pr.number,
    labels: [`${prefix}:implementation`, "needs-review"],
  });

  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: issueNum,
    body: `🔍 **Kiln** — Implementation PR ready: #${pr.number}`,
  });

  await transitionLabel(
    octokit,
    context,
    issueNum,
    "implementing",
    "in-review",
    prefix,
  );

  return { status: "success", prNumber: pr.number };
}
