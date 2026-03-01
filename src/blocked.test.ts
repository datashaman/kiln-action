import { checkBlocked } from "./blocked";
import { Context } from "@actions/github/lib/context";
import { KilnConfig, Octokit } from "./types";

function makeOctokit(overrides: {
  issueLabels?: Array<{ name: string }>;
  getThrows?: boolean;
} = {}): Octokit {
  const createComment = jest.fn().mockResolvedValue({});
  const get = overrides.getThrows
    ? jest.fn().mockRejectedValue(new Error("Not found"))
    : jest.fn().mockResolvedValue({
        data: { labels: overrides.issueLabels || [] },
      });

  return {
    rest: {
      issues: { createComment, get },
    },
  } as unknown as Octokit;
}

function makeConfig(prefix = "kiln"): KilnConfig {
  return { labels: { prefix } } as unknown as KilnConfig;
}

function makeContext(
  eventName: string,
  payload: Record<string, unknown>,
): Context {
  return {
    eventName,
    payload,
    repo: { owner: "test-owner", repo: "test-repo" },
  } as unknown as Context;
}

describe("checkBlocked", () => {
  // ── Issue events ───────────────────────────────────────
  describe("issue events", () => {
    it("returns true when issue has kiln:blocked label", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issues", {
        action: "opened",
        issue: {
          number: 1,
          labels: [{ name: "kiln:blocked" }],
        },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(true);
    });

    it("posts a comment when issue is blocked", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issues", {
        action: "opened",
        issue: {
          number: 1,
          labels: [{ name: "kiln:blocked" }],
        },
      });
      await checkBlocked(octokit, ctx, makeConfig());
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 1,
        body: "🔥 **Kiln** — Automation is blocked on this item. Remove kiln:blocked to resume.",
      });
    });

    it("returns false when issue does not have kiln:blocked label", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issues", {
        action: "opened",
        issue: {
          number: 2,
          labels: [{ name: "bug" }, { name: "kiln:intake" }],
        },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(false);
    });

    it("returns false when no issue in payload", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("push", {});
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(false);
    });

    it("does not post a comment when not blocked", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issues", {
        action: "opened",
        issue: { number: 3, labels: [] },
      });
      await checkBlocked(octokit, ctx, makeConfig());
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });
  });

  // ── PR events — PR labels ─────────────────────────────
  describe("PR events — PR labels", () => {
    it("returns true when PR has kiln:blocked label", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 10,
          labels: [{ name: "kiln:implementation" }, { name: "kiln:blocked" }],
          body: "Closes #5",
        },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(true);
    });

    it("posts a comment on the PR when PR is blocked via PR labels", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 10,
          labels: [{ name: "kiln:blocked" }],
          body: "Closes #5",
        },
      });
      await checkBlocked(octokit, ctx, makeConfig());
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 10 }),
      );
    });

    it("returns false when PR has no kiln:blocked label", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 11,
          labels: [{ name: "kiln:implementation" }],
          body: "Some PR body",
        },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(false);
    });
  });

  // ── PR events — linked issue labels ───────────────────
  describe("PR events — linked issue labels", () => {
    it("returns true when linked issue has kiln:blocked label", async () => {
      const octokit = makeOctokit({
        issueLabels: [{ name: "kiln:blocked" }],
      });
      const ctx = makeContext("pull_request_review", {
        action: "submitted",
        review: { state: "approved" },
        pull_request: {
          number: 20,
          labels: [{ name: "kiln:implementation" }],
          body: "Closes #7",
        },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(true);
    });

    it("posts a comment on the PR when blocked via linked issue", async () => {
      const octokit = makeOctokit({
        issueLabels: [{ name: "kiln:blocked" }],
      });
      const ctx = makeContext("pull_request_review", {
        action: "submitted",
        review: { state: "approved" },
        pull_request: {
          number: 20,
          labels: [{ name: "kiln:implementation" }],
          body: "Closes #7",
        },
      });
      await checkBlocked(octokit, ctx, makeConfig());
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 20 }),
      );
    });

    it("fetches the linked issue using the issue number from PR body", async () => {
      const octokit = makeOctokit({ issueLabels: [] });
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 21,
          labels: [],
          body: "Closes #42",
        },
      });
      await checkBlocked(octokit, ctx, makeConfig());
      expect(octokit.rest.issues.get).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 42,
      });
    });

    it("returns false when linked issue does not have kiln:blocked", async () => {
      const octokit = makeOctokit({
        issueLabels: [{ name: "kiln:implementing" }],
      });
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 22,
          labels: [],
          body: "Closes #8",
        },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(false);
    });

    it("returns false when issue fetch fails", async () => {
      const octokit = makeOctokit({ getThrows: true });
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 23,
          labels: [],
          body: "Closes #999",
        },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(false);
    });

    it("returns false when PR body has no Closes reference", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 24,
          labels: [],
          body: "Just a regular PR",
        },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(false);
    });
  });

  // ── Custom label prefix ────────────────────────────────
  describe("custom label prefix", () => {
    it("uses custom prefix for blocked label check", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issues", {
        action: "opened",
        issue: {
          number: 30,
          labels: [{ name: "myprefix:blocked" }],
        },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig("myprefix"));
      expect(result).toBe(true);
    });

    it("does not match kiln:blocked when prefix is custom", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issues", {
        action: "opened",
        issue: {
          number: 31,
          labels: [{ name: "kiln:blocked" }],
        },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig("myprefix"));
      expect(result).toBe(false);
    });
  });

  // ── All stages covered ─────────────────────────────────
  describe("covers all stages", () => {
    it("blocks triage (issues.opened)", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issues", {
        action: "opened",
        issue: { number: 40, labels: [{ name: "kiln:blocked" }] },
      });
      expect(await checkBlocked(octokit, ctx, makeConfig())).toBe(true);
    });

    it("blocks re-triage (issue_comment.created)", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issue_comment", {
        action: "created",
        issue: {
          number: 41,
          labels: [{ name: "kiln:needs-info" }, { name: "kiln:blocked" }],
        },
      });
      expect(await checkBlocked(octokit, ctx, makeConfig())).toBe(true);
    });

    it("blocks specify (issues.labeled)", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issues", {
        action: "labeled",
        label: { name: "kiln:specifying" },
        issue: { number: 42, labels: [{ name: "kiln:blocked" }] },
      });
      expect(await checkBlocked(octokit, ctx, makeConfig())).toBe(true);
    });

    it("blocks review (pull_request.opened)", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 43,
          labels: [{ name: "kiln:implementation" }, { name: "kiln:blocked" }],
          body: "",
        },
      });
      expect(await checkBlocked(octokit, ctx, makeConfig())).toBe(true);
    });

    it("blocks fix (pull_request_review.submitted changes_requested)", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("pull_request_review", {
        action: "submitted",
        review: { state: "changes_requested" },
        pull_request: {
          number: 44,
          labels: [{ name: "kiln:blocked" }],
          body: "",
        },
      });
      expect(await checkBlocked(octokit, ctx, makeConfig())).toBe(true);
    });

    it("blocks release (pull_request_review.submitted approved)", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("pull_request_review", {
        action: "submitted",
        review: { state: "approved" },
        pull_request: {
          number: 45,
          labels: [{ name: "kiln:blocked" }],
          body: "",
        },
      });
      expect(await checkBlocked(octokit, ctx, makeConfig())).toBe(true);
    });

    it("blocks approve-spec (pull_request_review.submitted approved on spec PR)", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("pull_request_review", {
        action: "submitted",
        review: { state: "approved" },
        pull_request: {
          number: 46,
          labels: [{ name: "kiln:spec" }, { name: "kiln:blocked" }],
          body: "",
        },
      });
      expect(await checkBlocked(octokit, ctx, makeConfig())).toBe(true);
    });
  });

  // ── Edge cases ─────────────────────────────────────────
  describe("edge cases", () => {
    it("exits cleanly (returns boolean, no throw) when blocked", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issues", {
        action: "opened",
        issue: { number: 50, labels: [{ name: "kiln:blocked" }] },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(typeof result).toBe("boolean");
      expect(result).toBe(true);
    });

    it("handles comment posting failure gracefully", async () => {
      const octokit = makeOctokit();
      (octokit.rest.issues.createComment as unknown as jest.Mock).mockRejectedValue(
        new Error("Forbidden"),
      );
      const ctx = makeContext("issues", {
        action: "opened",
        issue: { number: 51, labels: [{ name: "kiln:blocked" }] },
      });
      // Should not throw
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(true);
    });

    it("handles string labels in addition to object labels", async () => {
      const octokit = makeOctokit();
      const ctx = makeContext("issues", {
        action: "opened",
        issue: { number: 52, labels: ["kiln:blocked"] },
      });
      const result = await checkBlocked(octokit, ctx, makeConfig());
      expect(result).toBe(true);
    });
  });
});
