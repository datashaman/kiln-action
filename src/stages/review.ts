import * as core from "@actions/core";
import * as fs from "fs";
import { execSync } from "child_process";
import { runClaude } from "../claude";
import { KilnContext, StageResult } from "../types";

export default async function review(ctx: KilnContext): Promise<StageResult> {
  const { octokit, context, anthropicKey, timeoutMinutes } = ctx;
  const pr = context.payload.pull_request!;

  core.info(`🔥 Review — PR #${pr.number}: ${pr.title}`);

  // AC3: Check out the repo with full history (fetch-depth: 0)
  execSync("git fetch --unshallow || git fetch", { encoding: "utf-8" });
  execSync(`git checkout ${pr.head.ref}`, { encoding: "utf-8" });

  const { data: diff } = await octokit.rest.pulls.get({
    ...context.repo,
    pull_number: pr.number,
    mediaType: { format: "diff" },
  });

  const { data: files } = await octokit.rest.pulls.listFiles({
    ...context.repo,
    pull_number: pr.number,
    per_page: 100,
  });

  const fileList = files
    .map(
      (f) =>
        `${f.status}: ${f.filename} (+${f.additions} -${f.deletions})`,
    )
    .join("\n");

  const issueMatch = (pr.body as string | undefined)?.match(/Closes #(\d+)/i);
  const specRef = issueMatch ? `specs/issue-${issueMatch[1]}.md` : null;

  // AC4: Read the spec file content to include in the review prompt
  let specContent = "";
  if (specRef && fs.existsSync(specRef)) {
    specContent = fs.readFileSync(specRef, "utf-8");
  }

  const prompt = `You are the Kiln review agent — a senior code reviewer.

**PR #${pr.number}:** ${pr.title}
${specRef ? `**Spec:** ${specRef}` : ""}

${specContent ? `**Spec Content:**\n${specContent}\n` : ""}

**Changed files:**
${fileList}

**Diff:**
${String(diff).substring(0, 50000)}

${specRef ? "Review the implementation against the spec's acceptance criteria above." : ""}

Review for:
1. **Correctness** — Does it do what the spec says?
2. **Completeness** — Are all acceptance criteria met? All tests written?
3. **Security** — Any vulnerabilities? Input validation? Auth checks?
4. **Performance** — Any N+1 queries, unnecessary loops, memory leaks?
5. **Error handling** — Are errors caught and handled gracefully?
6. **Code style** — Does it match existing project conventions?
7. **Scope** — Are there any changes OUTSIDE the spec's scope?

Respond with a JSON block:
\`\`\`json
{
  "verdict": "approve" | "request_changes",
  "summary": "Overall assessment in 2-3 sentences",
  "issues": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical" | "major" | "minor" | "nit",
      "comment": "Description of the issue and how to fix it"
    }
  ]
}
\`\`\`

Be thorough but fair. Only request changes for real issues, not style preferences.`;

  const output = await runClaude(prompt, { anthropicKey, timeoutMinutes });

  let reviewResult: {
    verdict: string;
    summary: string;
    issues?: Array<{
      file: string;
      line: number;
      severity: string;
      comment: string;
    }>;
  };
  try {
    const jsonMatch =
      output.match(/```json\s*([\s\S]*?)\s*```/) ||
      output.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : output;
    reviewResult = JSON.parse(jsonStr);
  } catch {
    core.warning(`Failed to parse review response. Posting raw review.`);
    await octokit.rest.pulls.createReview({
      ...context.repo,
      pull_number: pr.number,
      body: `🔥 **Kiln Review**\n\n${output}`,
      event: "COMMENT",
    });
    return { status: "success" };
  }

  const comments = (reviewResult.issues || [])
    .filter((i) => i.file && i.line)
    .map((i) => ({
      path: i.file,
      line: i.line,
      body: `**${i.severity}:** ${i.comment}`,
    }));

  const event =
    reviewResult.verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES";

  const reviewBody = [
    `🔥 **Kiln Review**`,
    "",
    reviewResult.summary,
    "",
    reviewResult.issues?.length
      ? `Found **${reviewResult.issues.length}** issue(s): ${reviewResult.issues.filter((i) => i.severity === "critical").length} critical, ${reviewResult.issues.filter((i) => i.severity === "major").length} major, ${reviewResult.issues.filter((i) => i.severity === "minor").length} minor`
      : "No issues found. ✅",
  ].join("\n");

  try {
    await octokit.rest.pulls.createReview({
      ...context.repo,
      pull_number: pr.number,
      body: reviewBody,
      event,
      comments: comments.length > 0 ? comments : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(
      `Inline comments failed, posting summary review: ${message}`,
    );
    await octokit.rest.pulls.createReview({
      ...context.repo,
      pull_number: pr.number,
      body:
        reviewBody +
        "\n\n" +
        (reviewResult.issues || [])
          .map(
            (i) =>
              `- **${i.severity}** \`${i.file}:${i.line}\`: ${i.comment}`,
          )
          .join("\n"),
      event,
    });
  }

  return { status: "success", verdict: reviewResult.verdict };
}
