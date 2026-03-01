import * as core from "@actions/core";
import { Context } from "@actions/github/lib/context";
import { RouteResult } from "./types";

/**
 * Detects which Kiln stage to run based on the GitHub event.
 *
 * Event → Stage mapping:
 *
 *   issues.opened                                        → triage
 *   issue_comment.created (kiln:intake or kiln:needs-info) → re-triage
 *   issues.labeled  (kiln:specifying)                    → specify
 *   pull_request_review.submitted (approved + spec PR)   → approve-spec
 *   issues.labeled  (kiln:implementing)                  → implement
 *   pull_request.opened / synchronize (impl PR)          → review
 *   pull_request_review.submitted (changes_requested + impl PR) → fix
 *   pull_request_review.submitted (approved + impl PR)   → release
 *   check_suite.completed (impl PR)                      → release
 */
export function detectStage(context: Context): RouteResult | null {
  const { eventName, payload } = context;

  // ── Issue Events ──────────────────────────────────────
  if (eventName === "issues") {
    const issueNumber = payload.issue?.number as number | undefined;
    const issueLabels = extractLabels(payload.issue?.labels);

    // New issue opened → triage
    if (payload.action === "opened") {
      const result: RouteResult = {
        stage: "triage",
        issueNumber,
        labels: issueLabels,
        payload: payload as unknown as Record<string, unknown>,
      };
      core.info(`🔥 Kiln Router — Matched stage: triage (issues.opened)`);
      return result;
    }

    // Labeled events — check which label was just added
    if (payload.action === "labeled") {
      const added = payload.label?.name as string | undefined;

      if (added?.endsWith(":specifying")) {
        const result: RouteResult = {
          stage: "specify",
          issueNumber,
          labels: issueLabels,
          payload: payload as unknown as Record<string, unknown>,
        };
        core.info(
          `🔥 Kiln Router — Matched stage: specify (issues.labeled with ${added})`,
        );
        return result;
      }

      if (added?.endsWith(":implementing")) {
        const result: RouteResult = {
          stage: "implement",
          issueNumber,
          labels: issueLabels,
          payload: payload as unknown as Record<string, unknown>,
        };
        core.info(
          `🔥 Kiln Router — Matched stage: implement (issues.labeled with ${added})`,
        );
        return result;
      }
    }
  }

  // ── Issue Comment Events ──────────────────────────────
  if (eventName === "issue_comment") {
    if (payload.action === "created") {
      const issueNumber = payload.issue?.number as number | undefined;
      const issueLabels = extractLabels(payload.issue?.labels);

      if (
        issueLabels.some(
          (n) => n.endsWith(":intake") || n.endsWith(":needs-info"),
        )
      ) {
        const result: RouteResult = {
          stage: "re-triage",
          issueNumber,
          labels: issueLabels,
          payload: payload as unknown as Record<string, unknown>,
        };
        core.info(
          `🔥 Kiln Router — Matched stage: re-triage (issue_comment.created on issue with intake/needs-info label)`,
        );
        return result;
      }
    }
  }

  // ── Pull Request Events ───────────────────────────────
  if (eventName === "pull_request") {
    const prNumber = payload.pull_request?.number as number | undefined;
    const prLabels = extractLabels(payload.pull_request?.labels);

    // Impl PR opened or updated → review
    if (
      (payload.action === "opened" || payload.action === "synchronize") &&
      prLabels.some((l) => l.endsWith(":implementation"))
    ) {
      const result: RouteResult = {
        stage: "review",
        prNumber,
        labels: prLabels,
        payload: payload as unknown as Record<string, unknown>,
      };
      core.info(
        `🔥 Kiln Router — Matched stage: review (pull_request.${payload.action} with implementation label)`,
      );
      return result;
    }
  }

  // ── PR Review Events ──────────────────────────────────
  if (eventName === "pull_request_review") {
    const prNumber = payload.pull_request?.number as number | undefined;
    const prLabels = extractLabels(payload.pull_request?.labels);
    const state = payload.review?.state as string | undefined;

    // Spec PR approved → approve-spec (triggers implementation)
    if (state === "approved" && prLabels.some((l) => l.endsWith(":spec"))) {
      const result: RouteResult = {
        stage: "approve-spec",
        prNumber,
        labels: prLabels,
        payload: payload as unknown as Record<string, unknown>,
      };
      core.info(
        `🔥 Kiln Router — Matched stage: approve-spec (pull_request_review.submitted approved on spec PR)`,
      );
      return result;
    }

    // Impl PR: changes requested → fix
    if (
      state === "changes_requested" &&
      prLabels.some((l) => l.endsWith(":implementation"))
    ) {
      const result: RouteResult = {
        stage: "fix",
        prNumber,
        labels: prLabels,
        payload: payload as unknown as Record<string, unknown>,
      };
      core.info(
        `🔥 Kiln Router — Matched stage: fix (pull_request_review.submitted changes_requested on implementation PR)`,
      );
      return result;
    }

    // Impl PR: approved → release
    if (
      state === "approved" &&
      prLabels.some((l) => l.endsWith(":implementation"))
    ) {
      const result: RouteResult = {
        stage: "release",
        prNumber,
        labels: prLabels,
        payload: payload as unknown as Record<string, unknown>,
      };
      core.info(
        `🔥 Kiln Router — Matched stage: release (pull_request_review.submitted approved on implementation PR)`,
      );
      return result;
    }
  }

  // ── Check Suite (CI) Events ───────────────────────────
  if (eventName === "check_suite" && payload.action === "completed") {
    const prs =
      (payload.check_suite?.pull_requests as Array<unknown>) || [];
    if (prs.length > 0) {
      const result: RouteResult = {
        stage: "release",
        labels: [],
        payload: payload as unknown as Record<string, unknown>,
      };
      core.info(
        `🔥 Kiln Router — Matched stage: release (check_suite.completed with associated PRs)`,
      );
      return result;
    }
  }

  core.info(
    `🔥 Kiln Router — No matching stage for event: ${eventName}.${payload.action || ""}`,
  );
  return null;
}

function extractLabels(
  labels: unknown,
): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((l: { name: string }) => l.name);
}
