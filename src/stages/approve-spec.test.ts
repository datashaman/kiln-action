import approveSpec from "./approve-spec";
import { KilnContext, KilnConfig, Octokit } from "../types";
import { Context } from "@actions/github/lib/context";

jest.mock("@actions/core");
jest.mock("../labels");

import * as core from "@actions/core";
import { transitionLabel } from "../labels";

const mockedTransitionLabel = transitionLabel as unknown as jest.Mock;

function makeOctokit(): Octokit {
  return {
    rest: {
      pulls: {
        merge: jest.fn().mockResolvedValue({ data: {} }),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({}),
        addLabels: jest.fn().mockResolvedValue({}),
        removeLabel: jest.fn().mockResolvedValue({}),
      },
    },
  } as unknown as Octokit;
}

function makeConfig(
  overrides: Partial<KilnConfig> = {},
  prefix = "kiln",
): KilnConfig {
  return {
    labels: { prefix },
    ...overrides,
  } as unknown as KilnConfig;
}

function makeContext(prPayload: Record<string, unknown> = {}): Context {
  return {
    eventName: "pull_request_review",
    payload: {
      action: "submitted",
      review: { state: "approved" },
      pull_request: {
        number: 10,
        title: "📋 Kiln Spec: Add user authentication",
        body: "## Specification for #5\n\n🔥 *Fired in the Kiln*\n\nReview the spec at `specs/issue-5.md`.\n**Approve this PR to trigger implementation.**\n\n---\nTracking issue: #5",
        head: { ref: "kiln/spec/issue-5" },
        labels: [{ name: "kiln:spec" }],
        ...prPayload,
      },
    },
    repo: { owner: "test-owner", repo: "test-repo" },
  } as unknown as Context;
}

function makeCtx(overrides: Partial<KilnContext> = {}): KilnContext {
  return {
    octokit: makeOctokit(),
    context: makeContext(),
    config: makeConfig(),
    anthropicKey: "sk-ant-test-key",
    timeoutMinutes: 30,
    token: "ghp-test-token",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedTransitionLabel.mockResolvedValue(undefined);
});

describe("approveSpec", () => {
  // ── AC: Triggers on pull_request_review.submitted where state is approved ──
  describe("trigger on approved spec PR review", () => {
    it("processes an approved spec PR", async () => {
      const ctx = makeCtx();
      const result = await approveSpec(ctx);
      expect(result.status).toBe("success");
    });

    it("logs the PR number and title", async () => {
      const ctx = makeCtx();
      await approveSpec(ctx);
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("PR #10: 📋 Kiln Spec: Add user authentication"),
      );
    });
  });

  // ── AC: Merges the spec PR via squash merge ──
  describe("squash merges the spec PR", () => {
    it("merges the PR with squash method", async () => {
      const ctx = makeCtx();
      await approveSpec(ctx);

      expect(ctx.octokit.rest.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          pull_number: 10,
          merge_method: "squash",
        }),
      );
    });

    it("uses PR title in commit title", async () => {
      const ctx = makeCtx();
      await approveSpec(ctx);

      expect(ctx.octokit.rest.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({
          commit_title: "📋 Kiln Spec: Add user authentication (#10)",
        }),
      );
    });

    it("logs successful merge", async () => {
      const ctx = makeCtx();
      await approveSpec(ctx);

      expect(core.info).toHaveBeenCalledWith("Spec PR #10 merged.");
    });

    it("returns error with reason if merge fails", async () => {
      const ctx = makeCtx();
      (ctx.octokit.rest.pulls.merge as unknown as jest.Mock).mockRejectedValue(
        new Error("Merge conflict"),
      );

      const result = await approveSpec(ctx);
      expect(result.status).toBe("error");
      expect(result.reason).toBe(
        "Failed to merge spec PR: Merge conflict",
      );
      expect(core.setFailed).toHaveBeenCalledWith(
        "Failed to merge spec PR: Merge conflict",
      );
    });

    it("does not proceed if merge fails", async () => {
      const ctx = makeCtx();
      (ctx.octokit.rest.pulls.merge as unknown as jest.Mock).mockRejectedValue(
        new Error("Merge conflict"),
      );

      await approveSpec(ctx);
      expect(mockedTransitionLabel).not.toHaveBeenCalled();
      expect(ctx.octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });
  });

  // ── AC: Extracts the issue number from the branch name ──
  describe("extracts issue number from branch name", () => {
    it("extracts issue number from kiln/spec/issue-{number} branch", async () => {
      const ctx = makeCtx();
      await approveSpec(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        5,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("extracts different issue numbers from branch name", async () => {
      const ctx = makeCtx({
        context: makeContext({
          head: { ref: "kiln/spec/issue-42" },
        }),
      });
      await approveSpec(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        42,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("falls back to PR body if branch name doesn't match pattern", async () => {
      const ctx = makeCtx({
        context: makeContext({
          head: { ref: "some-other-branch" },
          body: "Tracking issue: #99",
        }),
      });
      await approveSpec(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        99,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("warns and returns success if no issue number found", async () => {
      const ctx = makeCtx({
        context: makeContext({
          head: { ref: "random-branch" },
          body: "No issue link here",
        }),
      });

      const result = await approveSpec(ctx);
      expect(result.status).toBe("success");
      expect(core.warning).toHaveBeenCalledWith(
        "Could not find linked issue number in branch name or PR body.",
      );
    });

    it("does not apply labels or comment if no issue number found", async () => {
      const ctx = makeCtx({
        context: makeContext({
          head: { ref: "random-branch" },
          body: "No issue link here",
        }),
      });

      await approveSpec(ctx);
      expect(mockedTransitionLabel).not.toHaveBeenCalled();
      expect(ctx.octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("handles missing head ref gracefully", async () => {
      const ctx = makeCtx({
        context: makeContext({
          head: undefined,
          body: "Tracking issue: #7",
        }),
      });

      await approveSpec(ctx);
      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        7,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("handles null body gracefully when branch also doesn't match", async () => {
      const ctx = makeCtx({
        context: makeContext({
          head: { ref: "other" },
          body: null,
        }),
      });

      const result = await approveSpec(ctx);
      expect(result.status).toBe("success");
      expect(core.warning).toHaveBeenCalled();
    });
  });

  // ── AC: Applies kiln:implementing label to the linked issue ──
  // ── AC: Removes kiln:spec-review label from the issue ──
  describe("issue label transition", () => {
    it("transitions issue from spec-review to implementing", async () => {
      const ctx = makeCtx();
      await approveSpec(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        ctx.octokit,
        ctx.context,
        5,
        "spec-review",
        "implementing",
        "kiln",
      );
    });

    it("uses custom label prefix for transition", async () => {
      const ctx = makeCtx({ config: makeConfig({}, "myapp") });
      await approveSpec(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        5,
        "spec-review",
        "implementing",
        "myapp",
      );
    });
  });

  // ── AC: Posts comment on the issue: implementation agent is starting ──
  describe("issue comment", () => {
    it("posts comment on the linked issue", async () => {
      const ctx = makeCtx();
      await approveSpec(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          issue_number: 5,
        }),
      );
    });

    it("comment mentions spec approved and implementation starting", async () => {
      const ctx = makeCtx();
      await approveSpec(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Spec approved"),
        }),
      );
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("implementation"),
        }),
      );
    });

    it("comment is Kiln-branded", async () => {
      const ctx = makeCtx();
      await approveSpec(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("**Kiln**"),
        }),
      );
    });
  });

  // ── Result ──
  describe("result", () => {
    it("returns success with nextStage implement", async () => {
      const ctx = makeCtx();
      const result = await approveSpec(ctx);

      expect(result).toEqual({
        status: "success",
        nextStage: "implement",
      });
    });
  });
});
