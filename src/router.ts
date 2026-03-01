import { Context } from "@actions/github/lib/context";

/**
 * Detects which Kiln stage to run based on the GitHub event.
 *
 * Event → Stage mapping:
 *
 *   issues.opened                                        → triage
 *   issues.labeled  (kiln:specifying)                    → specify
 *   pull_request_review.submitted (approved + spec PR)   → approve-spec
 *   issues.labeled  (kiln:implementing)                  → implement
 *   pull_request.opened (impl PR)                        → review
 *   pull_request_review.submitted (changes_requested)    → fix
 *   pull_request_review.submitted (approved + impl PR)   → ship
 *   check_suite.completed (impl PR, all green)           → ship
 */
export function detectStage(context: Context): string | null {
  const { eventName, payload } = context;

  // ── Issue Events ──────────────────────────────────────
  if (eventName === "issues") {
    // New issue opened → triage
    if (payload.action === "opened") {
      return "triage";
    }

    // Labeled events — check which label was just added
    if (payload.action === "labeled") {
      const added = payload.label?.name as string | undefined;

      if (added?.endsWith(":specifying")) return "specify";
      if (added?.endsWith(":implementing")) return "implement";
    }
  }

  // ── Issue Comment Events ──────────────────────────────
  if (eventName === "issue_comment") {
    if (payload.action === "created") {
      const labels =
        (payload.issue?.labels as Array<{ name: string }>) || [];
      const labelNames = labels.map((l) => l.name);
      if (
        labelNames.some(
          (n) => n.endsWith(":intake") || n.endsWith(":needs-info"),
        )
      ) {
        return "triage";
      }
    }
  }

  // ── Pull Request Events ───────────────────────────────
  if (eventName === "pull_request") {
    const labels =
      (payload.pull_request?.labels as Array<{ name: string }>) || [];
    const labelNames = labels.map((l) => l.name);

    // Impl PR opened or updated → review
    if (
      (payload.action === "opened" || payload.action === "synchronize") &&
      labelNames.some((l) => l.endsWith(":implementation"))
    ) {
      return "review";
    }
  }

  // ── PR Review Events ──────────────────────────────────
  if (eventName === "pull_request_review") {
    const labels =
      (payload.pull_request?.labels as Array<{ name: string }>) || [];
    const labelNames = labels.map((l) => l.name);
    const state = payload.review?.state as string | undefined;

    // Spec PR approved → approve-spec (triggers implementation)
    if (state === "approved" && labelNames.some((l) => l.endsWith(":spec"))) {
      return "approve-spec";
    }

    // Impl PR: changes requested → fix
    if (
      state === "changes_requested" &&
      labelNames.some((l) => l.endsWith(":implementation"))
    ) {
      return "fix";
    }

    // Impl PR: approved → ship
    if (
      state === "approved" &&
      labelNames.some((l) => l.endsWith(":implementation"))
    ) {
      return "ship";
    }
  }

  // ── Check Suite (CI) Events ───────────────────────────
  if (eventName === "check_suite" && payload.action === "completed") {
    const prs =
      (payload.check_suite?.pull_requests as Array<unknown>) || [];
    if (prs.length > 0) {
      return "ship";
    }
  }

  return null;
}
