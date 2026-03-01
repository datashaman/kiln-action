import * as core from "@actions/core";
import * as fs from "fs";
import { execSync } from "child_process";
import { runClaudeEdit } from "../claude";
import { transitionLabel } from "../labels";
import { KilnContext, StageResult } from "../types";

const DEFAULT_SPEC_TEMPLATE = `# Spec: [Title]

## 1. Overview
What this change does and why it's needed.

## 2. Requirements
- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
- [ ] Acceptance criterion 3

## 3. Technical Design

### Files to create/modify
| File | Action | Purpose |
|---|---|---|
| path/to/file | create/modify | description |

### Key interfaces / types
\`\`\`typescript
// Define key interfaces here
\`\`\`

### Data flow
Describe how data moves through the system.

### Edge cases
- Edge case 1
- Edge case 2

## 4. Test Plan

### Unit tests
- Test case 1
- Test case 2

### Integration tests
- Test case 1

### Manual verification
- Step 1
- Step 2

## 5. Out of Scope
What this change does NOT cover.

## 6. Implementation Notes
- Suggested order of implementation
- Potential pitfalls or gotchas
`;

export default async function specify(
  ctx: KilnContext,
): Promise<StageResult> {
  const { octokit, context, config, anthropicKey, timeoutMinutes } = ctx;
  const issue = context.payload.issue!;
  const prefix = config.labels?.prefix || "kiln";
  const issueNum = issue.number;
  const branchName = `kiln/spec/issue-${issueNum}`;

  core.info(`🔥 Specify — Issue #${issueNum}: ${issue.title}`);

  // AC4: If a spec PR already exists for this issue, don't create a duplicate
  const { data: existingPRs } = await octokit.rest.pulls.list({
    ...context.repo,
    head: `${context.repo.owner}:${branchName}`,
    state: "open",
  });
  if (existingPRs.length > 0) {
    core.info(
      `🔥 Specify — Spec PR already exists for issue #${issueNum}: #${existingPRs[0].number}. Skipping.`,
    );
    return { status: "skipped", reason: "duplicate", prNumber: existingPRs[0].number };
  }

  execSync('git config user.name "kiln[bot]"');
  execSync('git config user.email "kiln[bot]@users.noreply.github.com"');
  execSync(`git checkout -b ${branchName}`);

  fs.mkdirSync("specs", { recursive: true });

  let specTemplate = DEFAULT_SPEC_TEMPLATE;
  const templatePath =
    config.spec_template || config.agents?.spec?.template;
  if (templatePath && fs.existsSync(templatePath)) {
    specTemplate = fs.readFileSync(templatePath, "utf-8");
    core.info(`🔥 Using custom spec template: ${templatePath}`);
  }

  const prompt = `You are the Kiln spec agent. Your job is to produce a detailed, implementable specification.

**Issue #${issueNum}**
**Title:** ${issue.title}
**Body:** ${issue.body || "(empty)"}

First, read the existing codebase to understand the project structure, conventions, tech stack, and patterns.

Then create the spec file at: specs/issue-${issueNum}.md

Use this structure for the spec:

${specTemplate}

Important:
- Be specific about which files to create or modify
- Include concrete type/interface definitions where relevant
- Acceptance criteria must be testable
- Reference existing patterns in the codebase
- The implementation agent will use this spec as its SOLE instruction set

After creating the spec file, commit it to the current branch with message:
"docs: add spec for issue #${issueNum}"

Then push the branch.`;

  runClaudeEdit(prompt, { anthropicKey, timeoutMinutes });

  const specPath = `specs/issue-${issueNum}.md`;
  if (!fs.existsSync(specPath)) {
    core.setFailed(`Spec agent did not create ${specPath}`);
    return { status: "error" };
  }

  try {
    execSync(
      `git add -A && git commit -m "docs: add spec for issue #${issueNum}" --allow-empty`,
    );
  } catch {
    // Already committed by Claude
  }
  execSync(`git push origin ${branchName} --force`);

  const { data: pr } = await octokit.rest.pulls.create({
    ...context.repo,
    title: `📋 Kiln Spec: ${issue.title}`,
    body: [
      `## Specification for #${issueNum}`,
      "",
      "🔥 *Fired in the Kiln*",
      "",
      `Review the spec at \`${specPath}\`.`,
      "**Approve this PR to trigger implementation.**",
      "",
      "---",
      `Tracking issue: #${issueNum}`,
    ].join("\n"),
    head: branchName,
    base: "main",
  });

  await octokit.rest.issues.addLabels({
    ...context.repo,
    issue_number: pr.number,
    labels: [`${prefix}:spec`, "needs-human-review"],
  });

  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: issueNum,
    body: `📋 **Kiln** — Spec ready for review: #${pr.number}\n\nApprove the spec PR to start implementation.`,
  });

  await transitionLabel(
    octokit,
    context,
    issueNum,
    "specifying",
    "spec-review",
    prefix,
  );

  return { status: "success", prNumber: pr.number };
}
