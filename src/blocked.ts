import { KilnContext } from "./types";

const BLOCKED_COMMENT =
  "🔥 **Kiln** — Automation is blocked on this item. Remove kiln:blocked to resume.";

export async function checkBlocked(
  octokit: KilnContext["octokit"],
  context: KilnContext["context"],
  config: KilnContext["config"],
): Promise<boolean> {
  const prefix = config.labels?.prefix || "kiln";
  const blockedLabel = `${prefix}:blocked`;

  const hasLabel = (
    labels: Array<string | { name?: string }> | undefined,
  ): boolean =>
    !!labels?.some(
      (l) => (typeof l === "string" ? l : l.name) === blockedLabel,
    );

  // For PR events, check both PR labels and linked issue labels
  if (context.payload.pull_request) {
    const prLabels = context.payload.pull_request.labels as
      | Array<{ name?: string }>
      | undefined;
    const prNumber = context.payload.pull_request.number as number;

    if (hasLabel(prLabels)) {
      await postBlockedComment(octokit, context, prNumber);
      return true;
    }

    // Also check the linked issue
    const match = (
      context.payload.pull_request.body as string | undefined
    )?.match(/Closes #(\d+)/i);
    if (match) {
      const issueNumber = parseInt(match[1], 10);
      try {
        const { data: issue } = await octokit.rest.issues.get({
          ...context.repo,
          issue_number: issueNumber,
        });
        if (hasLabel(issue.labels)) {
          await postBlockedComment(octokit, context, prNumber);
          return true;
        }
      } catch {
        // Issue not found or inaccessible — not blocked
      }
    }

    return false;
  }

  // For issue events, check the issue labels
  const issueNumber = context.payload.issue?.number as number | undefined;
  if (!issueNumber) return false;

  const issueLabels = context.payload.issue?.labels as
    | Array<{ name?: string }>
    | undefined;

  if (hasLabel(issueLabels)) {
    await postBlockedComment(octokit, context, issueNumber);
    return true;
  }

  return false;
}

async function postBlockedComment(
  octokit: KilnContext["octokit"],
  context: KilnContext["context"],
  issueOrPrNumber: number,
): Promise<void> {
  try {
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: issueOrPrNumber,
      body: BLOCKED_COMMENT,
    });
  } catch {
    // Best-effort comment; don't fail the guard if comment posting fails
  }
}
