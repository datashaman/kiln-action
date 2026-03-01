import ship from "./ship";
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
        listReviews: jest
          .fn()
          .mockResolvedValue({ data: [{ state: "APPROVED" }] }),
        merge: jest.fn().mockResolvedValue({ data: {} }),
        get: jest.fn().mockResolvedValue({
          data: {
            number: 20,
            title: "🔨 Kiln Impl: Add feature",
            body: "Closes #5",
            head: { sha: "abc123" },
            labels: [{ name: "kiln:implementation" }],
          },
        }),
      },
      checks: {
        listForRef: jest.fn().mockResolvedValue({
          data: {
            check_runs: [
              { name: "ci", conclusion: "success", status: "completed" },
            ],
          },
        }),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
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
    auto_merge: true,
    ...overrides,
  } as unknown as KilnConfig;
}

function makeContext(
  prPayload: Record<string, unknown> = {},
  eventOverrides: Record<string, unknown> = {},
): Context {
  return {
    eventName: "pull_request_review",
    payload: {
      action: "submitted",
      review: { state: "approved" },
      pull_request: {
        number: 20,
        title: "🔨 Kiln Impl: Add feature",
        body: "Implementation for spec.\n\nCloses #5",
        head: { sha: "abc123" },
        labels: [{ name: "kiln:implementation" }],
        ...prPayload,
      },
      ...eventOverrides,
    },
    repo: { owner: "test-owner", repo: "test-repo" },
  } as unknown as Context;
}

function makeCheckSuiteContext(
  suitePrs: Array<{ number: number }> = [{ number: 20 }],
): Context {
  return {
    eventName: "check_suite",
    payload: {
      action: "completed",
      check_suite: {
        pull_requests: suitePrs,
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

describe("ship", () => {
  // ── AC1: Triggers on pull_request_review.submitted (approved) and check_suite.completed ──
  describe("trigger events", () => {
    it("processes a pull_request_review.submitted approved event", async () => {
      const ctx = makeCtx();
      const result = await ship(ctx);
      expect(result.status).toBe("success");
    });

    it("processes a check_suite.completed event by fetching PR details", async () => {
      const octokit = makeOctokit();
      const ctx = makeCtx({
        octokit,
        context: makeCheckSuiteContext([{ number: 20 }]),
      });
      const result = await ship(ctx);

      expect(octokit.rest.pulls.get).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 20 }),
      );
      expect(result.status).toBe("success");
    });

    it("skips if check_suite has no associated PRs", async () => {
      const ctx = makeCtx({
        context: makeCheckSuiteContext([]),
      });
      const result = await ship(ctx);
      expect(result.status).toBe("skipped");
    });

    it("skips if no PR in payload (non-check_suite event)", async () => {
      const ctx = makeCtx({
        context: {
          eventName: "push",
          payload: {},
          repo: { owner: "test-owner", repo: "test-repo" },
        } as unknown as Context,
      });
      const result = await ship(ctx);
      expect(result.status).toBe("skipped");
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("No PR in payload"),
      );
    });

    it("logs the PR number being checked", async () => {
      const ctx = makeCtx();
      await ship(ctx);
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("PR #20"),
      );
    });
  });

  // ── AC2: Only runs on PRs with the kiln:implementation label ──
  describe("implementation label check", () => {
    it("skips if PR does not have implementation label", async () => {
      const ctx = makeCtx({
        context: makeContext({ labels: [{ name: "kiln:spec" }] }),
      });
      const result = await ship(ctx);
      expect(result.status).toBe("skipped");
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("does not have implementation label"),
      );
    });

    it("proceeds if PR has implementation label", async () => {
      const ctx = makeCtx();
      const result = await ship(ctx);
      expect(result.status).toBe("success");
    });

    it("checks implementation label on check_suite PRs too", async () => {
      const octokit = makeOctokit();
      // PR fetched via pulls.get has no implementation label
      (octokit.rest.pulls.get as unknown as jest.Mock).mockResolvedValue({
        data: {
          number: 20,
          title: "Some PR",
          body: "Closes #5",
          head: { sha: "abc123" },
          labels: [{ name: "kiln:spec" }],
        },
      });
      const ctx = makeCtx({
        octokit,
        context: makeCheckSuiteContext([{ number: 20 }]),
      });
      const result = await ship(ctx);
      expect(result.status).toBe("skipped");
    });

    it("supports custom label prefix for implementation check", async () => {
      const ctx = makeCtx({
        config: makeConfig({}, "myapp"),
        context: makeContext({
          labels: [{ name: "myapp:implementation" }],
        }),
      });
      const result = await ship(ctx);
      expect(result.status).toBe("success");
    });
  });

  // ── AC3: Checks that the PR has at least one approval ──
  describe("approval check", () => {
    it("skips if no approvals", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listReviews as unknown as jest.Mock).mockResolvedValue({
        data: [{ state: "COMMENTED" }],
      });
      const ctx = makeCtx({ octokit });
      const result = await ship(ctx);

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("not-approved");
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("not yet approved"),
      );
    });

    it("skips if only changes_requested reviews", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listReviews as unknown as jest.Mock).mockResolvedValue({
        data: [{ state: "CHANGES_REQUESTED" }],
      });
      const ctx = makeCtx({ octokit });
      const result = await ship(ctx);

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("not-approved");
    });

    it("proceeds if at least one approval exists among mixed reviews", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listReviews as unknown as jest.Mock).mockResolvedValue({
        data: [
          { state: "CHANGES_REQUESTED" },
          { state: "APPROVED" },
          { state: "COMMENTED" },
        ],
      });
      const ctx = makeCtx({ octokit });
      const result = await ship(ctx);

      expect(result.status).toBe("success");
    });

    it("proceeds with empty review list skipped", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listReviews as unknown as jest.Mock).mockResolvedValue({
        data: [],
      });
      const ctx = makeCtx({ octokit });
      const result = await ship(ctx);

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("not-approved");
    });
  });

  // ── AC4: Checks that all CI checks are passing (success or skipped) ──
  describe("CI checks", () => {
    it("skips if CI checks are failing", async () => {
      const octokit = makeOctokit();
      (octokit.rest.checks.listForRef as unknown as jest.Mock).mockResolvedValue({
        data: {
          check_runs: [
            { name: "ci", conclusion: "failure", status: "completed" },
          ],
        },
      });
      const ctx = makeCtx({ octokit });
      const result = await ship(ctx);

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("ci-pending");
    });

    it("passes if all checks are success", async () => {
      const ctx = makeCtx();
      const result = await ship(ctx);
      expect(result.status).toBe("success");
    });

    it("passes if checks are mix of success and skipped", async () => {
      const octokit = makeOctokit();
      (octokit.rest.checks.listForRef as unknown as jest.Mock).mockResolvedValue({
        data: {
          check_runs: [
            { name: "ci", conclusion: "success", status: "completed" },
            { name: "lint", conclusion: "skipped", status: "completed" },
          ],
        },
      });
      const ctx = makeCtx({ octokit });
      const result = await ship(ctx);

      expect(result.status).toBe("success");
    });

    it("ignores the kiln check itself", async () => {
      const octokit = makeOctokit();
      (octokit.rest.checks.listForRef as unknown as jest.Mock).mockResolvedValue({
        data: {
          check_runs: [
            { name: "kiln", conclusion: "failure", status: "completed" },
            { name: "ci", conclusion: "success", status: "completed" },
          ],
        },
      });
      const ctx = makeCtx({ octokit });
      const result = await ship(ctx);

      expect(result.status).toBe("success");
    });

    it("does not treat queued checks as passing", async () => {
      const octokit = makeOctokit();
      (octokit.rest.checks.listForRef as unknown as jest.Mock).mockResolvedValue({
        data: {
          check_runs: [
            { name: "ci", conclusion: null, status: "queued" },
          ],
        },
      });
      const ctx = makeCtx({ octokit });
      const result = await ship(ctx);

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("ci-pending");
    });

    it("uses PR head SHA for check lookup", async () => {
      const octokit = makeOctokit();
      const ctx = makeCtx({ octokit });
      await ship(ctx);

      expect(octokit.rest.checks.listForRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "abc123" }),
      );
    });
  });

  // ── AC5: If both conditions met: merges the PR via squash merge ──
  describe("squash merge", () => {
    it("merges the PR with squash method", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(ctx.octokit.rest.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          pull_number: 20,
          merge_method: "squash",
        }),
      );
    });

    it("uses PR title in commit title", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(ctx.octokit.rest.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({
          commit_title: "🔨 Kiln Impl: Add feature (#20)",
        }),
      );
    });

    it("returns error if merge fails", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.merge as unknown as jest.Mock).mockRejectedValue(
        new Error("Merge conflict"),
      );
      const ctx = makeCtx({ octokit });

      const result = await ship(ctx);
      expect(result.status).toBe("error");
      expect(result.reason).toBe("merge-failed");
      expect(core.warning).toHaveBeenCalledWith(
        "Merge failed: Merge conflict",
      );
    });

    it("does not close issue or post comment if merge fails", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.merge as unknown as jest.Mock).mockRejectedValue(
        new Error("Merge conflict"),
      );
      const ctx = makeCtx({ octokit });

      await ship(ctx);
      expect(mockedTransitionLabel).not.toHaveBeenCalled();
      expect(octokit.rest.issues.update).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("logs the merge action", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Merging PR #20"),
      );
    });
  });

  // ── AC6: Extracts issue number from PR body (Closes #N) ──
  describe("issue number extraction", () => {
    it("extracts issue number from 'Closes #N' in PR body", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        5,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("handles case-insensitive 'closes #N'", async () => {
      const ctx = makeCtx({
        context: makeContext({ body: "closes #42" }),
      });
      await ship(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        42,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("handles 'CLOSES #N' uppercase", async () => {
      const ctx = makeCtx({
        context: makeContext({ body: "CLOSES #99" }),
      });
      await ship(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        99,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("does not fail if no Closes #N in body", async () => {
      const ctx = makeCtx({
        context: makeContext({ body: "Just some PR body" }),
      });
      const result = await ship(ctx);

      expect(result.status).toBe("success");
      expect(mockedTransitionLabel).not.toHaveBeenCalled();
      expect(ctx.octokit.rest.issues.update).not.toHaveBeenCalled();
    });

    it("does not fail if PR body is null", async () => {
      const ctx = makeCtx({
        context: makeContext({ body: null }),
      });
      const result = await ship(ctx);

      expect(result.status).toBe("success");
      expect(mockedTransitionLabel).not.toHaveBeenCalled();
    });
  });

  // ── AC7: Applies kiln:done label to the issue ──
  describe("done label", () => {
    it("transitions issue from in-review to done", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        ctx.octokit,
        ctx.context,
        5,
        "in-review",
        "done",
        "kiln",
      );
    });

    it("uses custom label prefix", async () => {
      const ctx = makeCtx({ config: makeConfig({}, "myapp") });
      await ship(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        5,
        "in-review",
        "done",
        "myapp",
      );
    });
  });

  // ── AC8: Closes the issue ──
  describe("close issue", () => {
    it("closes the linked issue", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(ctx.octokit.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          issue_number: 5,
          state: "closed",
        }),
      );
    });

    it("does not close issue if no issue number found", async () => {
      const ctx = makeCtx({
        context: makeContext({ body: "No linked issue" }),
      });
      await ship(ctx);

      expect(ctx.octokit.rest.issues.update).not.toHaveBeenCalled();
    });
  });

  // ── AC9: Posts a final Kiln comment on the issue confirming release ──
  describe("release comment", () => {
    it("posts a Kiln-branded comment on the issue", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          issue_number: 5,
          body: expect.stringContaining("**Kiln**"),
        }),
      );
    });

    it("comment mentions shipped", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Shipped"),
        }),
      );
    });

    it("comment references the PR number", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("#20"),
        }),
      );
    });

    it("logs issue closure", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Issue #5 closed"),
      );
    });

    it("logs shipped message", async () => {
      const ctx = makeCtx();
      await ship(ctx);

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Shipped"),
      );
    });
  });

  // ── AC10: If conditions not met: no-op (waits for remaining condition) ──
  describe("no-op when conditions not met", () => {
    it("does not merge when not approved", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listReviews as unknown as jest.Mock).mockResolvedValue({
        data: [],
      });
      const ctx = makeCtx({ octokit });
      await ship(ctx);

      expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
    });

    it("does not merge when CI not passing", async () => {
      const octokit = makeOctokit();
      (octokit.rest.checks.listForRef as unknown as jest.Mock).mockResolvedValue({
        data: {
          check_runs: [
            { name: "ci", conclusion: "failure", status: "completed" },
          ],
        },
      });
      const ctx = makeCtx({ octokit });
      await ship(ctx);

      expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
    });

    it("does not touch issue when not approved", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listReviews as unknown as jest.Mock).mockResolvedValue({
        data: [],
      });
      const ctx = makeCtx({ octokit });
      await ship(ctx);

      expect(mockedTransitionLabel).not.toHaveBeenCalled();
      expect(octokit.rest.issues.update).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });
  });

  // ── Auto-merge disabled ──
  describe("auto-merge disabled", () => {
    it("posts comment but does not merge when auto_merge is false", async () => {
      const ctx = makeCtx({
        config: makeConfig({ auto_merge: false }),
      });
      const result = await ship(ctx);

      expect(result.status).toBe("success");
      expect(result.reason).toBe("auto-merge-disabled");
      expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Auto-merge is disabled"),
        }),
      );
    });
  });
});
