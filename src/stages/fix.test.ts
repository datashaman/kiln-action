import fix from "./fix";
import { KilnContext, KilnConfig, Octokit } from "../types";
import { Context } from "@actions/github/lib/context";

jest.mock("@actions/core");
jest.mock("../claude");
jest.mock("child_process", () => ({
  execSync: jest.fn().mockReturnValue(""),
}));

import * as core from "@actions/core";
import { runClaudeEdit, runClaude } from "../claude";
import { execSync } from "child_process";

const mockedRunClaudeEdit = runClaudeEdit as unknown as jest.Mock;
const mockedRunClaude = runClaude as unknown as jest.Mock;
const mockedExecSync = execSync as unknown as jest.Mock;

function makeOctokit(overrides: Record<string, unknown> = {}): Octokit {
  return {
    rest: {
      pulls: {
        listCommits: jest.fn().mockResolvedValue({
          data: [],
        }),
        listReviews: jest.fn().mockResolvedValue({
          data: [
            {
              state: "CHANGES_REQUESTED",
              body: "Please fix the error handling in auth.ts",
            },
          ],
        }),
        listReviewComments: jest.fn().mockResolvedValue({
          data: [
            {
              id: 101,
              path: "src/auth.ts",
              line: 42,
              original_line: 42,
              body: "Missing input validation on user data",
            },
            {
              id: 102,
              path: "src/utils.ts",
              line: 10,
              original_line: 10,
              body: "Error is silently swallowed here",
            },
          ],
        }),
        createReplyForReviewComment: jest.fn().mockResolvedValue({}),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({}),
        addLabels: jest.fn().mockResolvedValue({}),
      },
      ...overrides,
    },
  } as unknown as Octokit;
}

function makeConfig(
  overrides: Partial<KilnConfig> = {},
  prefix = "kiln",
): KilnConfig {
  return {
    labels: { prefix },
    agents: {
      fix: { enabled: true, max_iterations: 3 },
    },
    ...overrides,
  } as unknown as KilnConfig;
}

function makeContext(prPayload: Record<string, unknown> = {}): Context {
  return {
    eventName: "pull_request_review",
    payload: {
      action: "submitted",
      review: { state: "changes_requested" },
      pull_request: {
        number: 10,
        title: "🔨 Kiln Impl: Add user authentication",
        body: "## Implementation for #5\n\n📋 Spec: `specs/issue-5.md`\n\nCloses #5",
        head: { ref: "kiln/impl/issue-5" },
        labels: [{ name: "kiln:implementation" }],
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
  mockedExecSync.mockReturnValue("");
  mockedRunClaudeEdit.mockReturnValue("");
  mockedRunClaude.mockReturnValue("Added input validation for user data.");
});

describe("fix", () => {
  // ── AC1: Triggers on pull_request_review.submitted where state is changes_requested ──
  describe("trigger and logging", () => {
    it("processes the fix event and returns success", async () => {
      const ctx = makeCtx();
      const result = await fix(ctx);
      expect(result.status).toBe("success");
    });

    it("logs the PR number and title", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("PR #10: addressing review feedback"),
      );
    });
  });

  // ── AC3: Checks out the PR's head branch ──
  describe("checks out PR head branch", () => {
    it("fetches the PR head branch", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(mockedExecSync).toHaveBeenCalledWith(
        "git fetch origin kiln/impl/issue-5",
      );
    });

    it("checks out the PR head branch", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout kiln/impl/issue-5",
      );
    });

    it("configures git user as kiln[bot]", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(mockedExecSync).toHaveBeenCalledWith(
        'git config user.name "kiln[bot]"',
      );
      expect(mockedExecSync).toHaveBeenCalledWith(
        'git config user.email "kiln[bot]@users.noreply.github.com"',
      );
    });
  });

  // ── AC4: Claude reads all review comments and inline feedback ──
  describe("reads review comments and feedback", () => {
    it("fetches reviews via GitHub API", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(ctx.octokit.rest.pulls.listReviews).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          pull_number: 10,
        }),
      );
    });

    it("fetches review comments via GitHub API", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(ctx.octokit.rest.pulls.listReviewComments).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          pull_number: 10,
        }),
      );
    });

    it("includes review summary in the Claude prompt", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("Please fix the error handling in auth.ts");
    });

    it("includes inline review comments in the Claude prompt", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("src/auth.ts:42");
      expect(prompt).toContain("Missing input validation on user data");
      expect(prompt).toContain("src/utils.ts:10");
      expect(prompt).toContain("Error is silently swallowed here");
    });

    it("only includes CHANGES_REQUESTED reviews (not approved)", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listReviews as unknown as jest.Mock).mockResolvedValue({
        data: [
          { state: "APPROVED", body: "Looks good!" },
          { state: "CHANGES_REQUESTED", body: "Fix the bug" },
        ],
      });
      const ctx = makeCtx({ octokit });
      await fix(ctx);
      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("Fix the bug");
      expect(prompt).not.toContain("Looks good!");
    });
  });

  // ── AC5: Claude addresses each comment ──
  describe("Claude addresses review feedback", () => {
    it("invokes Claude in edit mode with the fix prompt", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(mockedRunClaudeEdit).toHaveBeenCalledWith(
        expect.stringContaining("Kiln fix agent"),
        { anthropicKey: "sk-ant-test-key", timeoutMinutes: 30 },
      );
    });

    it("prompt instructs fixing code issues", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("Fix code issues");
    });

    it("prompt instructs adding missing tests if requested", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("Add missing tests");
    });

    it("prompt instructs addressing all concerns", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("Address all concerns");
    });
  });

  // ── AC6: Claude commits fixes and pushes to the PR branch ──
  describe("commits and pushes", () => {
    it("prompt instructs committing with kiln-fix tag", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("kiln-fix #1");
    });

    it("pushes to the PR head branch after Claude finishes", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(mockedExecSync).toHaveBeenCalledWith(
        "git push origin kiln/impl/issue-5",
      );
    });

    it("handles push failure gracefully (Claude may have already pushed)", async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd.startsWith("git push")) {
          throw new Error("already up-to-date");
        }
        return "";
      });
      const ctx = makeCtx();
      const result = await fix(ctx);
      expect(result.status).toBe("success");
    });
  });

  // ── AC7: Claude replies to each review comment explaining the changes made ──
  describe("replies to review comments", () => {
    it("replies to each inline review comment", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(
        ctx.octokit.rest.pulls.createReplyForReviewComment,
      ).toHaveBeenCalledTimes(2);
    });

    it("replies to comment 101 with Kiln-branded message", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(
        ctx.octokit.rest.pulls.createReplyForReviewComment,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          pull_number: 10,
          comment_id: 101,
          body: expect.stringContaining("🔧 **Kiln**"),
        }),
      );
    });

    it("replies to comment 102 with Kiln-branded message", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(
        ctx.octokit.rest.pulls.createReplyForReviewComment,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: 102,
          body: expect.stringContaining("🔧 **Kiln**"),
        }),
      );
    });

    it("uses runClaude (read-only) to generate reply text", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      // runClaude should be called once per review comment for replies
      expect(mockedRunClaude).toHaveBeenCalledTimes(2);
    });

    it("includes the comment context in the reply prompt", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      const firstPrompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(firstPrompt).toContain("src/auth.ts:42");
      expect(firstPrompt).toContain("Missing input validation on user data");
    });

    it("handles reply failure gracefully with warning", async () => {
      const octokit = makeOctokit();
      (
        octokit.rest.pulls.createReplyForReviewComment as unknown as jest.Mock
      ).mockRejectedValue(new Error("API error"));
      const ctx = makeCtx({ octokit });
      const result = await fix(ctx);

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to reply to review comment"),
      );
      expect(result.status).toBe("success");
    });

    it("handles Claude reply generation failure gracefully", async () => {
      mockedRunClaude.mockImplementation(() => {
        throw new Error("Claude timeout");
      });
      const ctx = makeCtx();
      const result = await fix(ctx);

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to reply to review comment"),
      );
      expect(result.status).toBe("success");
    });

    it("does not reply when there are no review comments", async () => {
      const octokit = makeOctokit();
      (
        octokit.rest.pulls.listReviewComments as unknown as jest.Mock
      ).mockResolvedValue({ data: [] });
      const ctx = makeCtx({ octokit });
      await fix(ctx);

      expect(
        octokit.rest.pulls.createReplyForReviewComment,
      ).not.toHaveBeenCalled();
      expect(mockedRunClaude).not.toHaveBeenCalled();
    });

    it("uses comment.original_line when line is null", async () => {
      const octokit = makeOctokit();
      (
        octokit.rest.pulls.listReviewComments as unknown as jest.Mock
      ).mockResolvedValue({
        data: [
          {
            id: 201,
            path: "src/old.ts",
            line: null,
            original_line: 55,
            body: "Outdated comment on old line",
          },
        ],
      });
      const ctx = makeCtx({ octokit });
      await fix(ctx);

      const replyPrompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(replyPrompt).toContain("src/old.ts:55");
    });
  });

  // ── Post-fix comment ──
  describe("posts completion comment", () => {
    it("posts a branded comment with iteration count", async () => {
      const ctx = makeCtx();
      await fix(ctx);
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 10,
          body: expect.stringContaining(
            "Review feedback addressed (iteration 1/3)",
          ),
        }),
      );
    });

    it("returns iteration number in result", async () => {
      const ctx = makeCtx();
      const result = await fix(ctx);
      expect(result.iteration).toBe(1);
    });
  });

  // ── AC8: Push triggers re-review (inherent to push + router) ──
  // This is tested implicitly: the push to the PR branch triggers a
  // pull_request.synchronize event which the router maps to the review stage.

  // ── Max iterations limit ──
  describe("max iterations guard", () => {
    it("stops when max iterations reached", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listCommits as unknown as jest.Mock).mockResolvedValue({
        data: [
          { commit: { message: "fix: kiln-fix #1" } },
          { commit: { message: "fix: kiln-fix #2" } },
          { commit: { message: "fix: kiln-fix #3" } },
        ],
      });
      const ctx = makeCtx({ octokit });
      const result = await fix(ctx);

      expect(result.status).toBe("max-iterations");
      expect(mockedRunClaudeEdit).not.toHaveBeenCalled();
    });

    it("posts a warning comment when max iterations reached", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listCommits as unknown as jest.Mock).mockResolvedValue({
        data: [
          { commit: { message: "fix: kiln-fix #1" } },
          { commit: { message: "fix: kiln-fix #2" } },
          { commit: { message: "fix: kiln-fix #3" } },
        ],
      });
      const ctx = makeCtx({ octokit });
      await fix(ctx);

      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("maximum of 3 iterations"),
        }),
      );
    });

    it("adds needs-human-review label when max iterations reached", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listCommits as unknown as jest.Mock).mockResolvedValue({
        data: [
          { commit: { message: "fix: kiln-fix #1" } },
          { commit: { message: "fix: kiln-fix #2" } },
          { commit: { message: "fix: kiln-fix #3" } },
        ],
      });
      const ctx = makeCtx({ octokit });
      await fix(ctx);

      expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: ["needs-human-review"],
        }),
      );
    });

    it("increments fix count correctly on second iteration", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listCommits as unknown as jest.Mock).mockResolvedValue({
        data: [{ commit: { message: "fix: address review feedback (kiln-fix #1)" } }],
      });
      const ctx = makeCtx({ octokit });
      const result = await fix(ctx);

      expect(result.status).toBe("success");
      expect(result.iteration).toBe(2);
      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("kiln-fix #2");
    });

    it("respects custom max_iterations from config", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listCommits as unknown as jest.Mock).mockResolvedValue({
        data: [{ commit: { message: "fix: kiln-fix #1" } }],
      });
      const ctx = makeCtx({
        octokit,
        config: makeConfig({
          agents: {
            fix: { enabled: true, max_iterations: 1 },
          },
        } as Partial<KilnConfig>),
      });
      const result = await fix(ctx);

      expect(result.status).toBe("max-iterations");
    });

    it("counts only commits with kiln-fix marker", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listCommits as unknown as jest.Mock).mockResolvedValue({
        data: [
          { commit: { message: "feat: initial implementation" } },
          { commit: { message: "fix: address review feedback (kiln-fix #1)" } },
          { commit: { message: "chore: format code" } },
        ],
      });
      const ctx = makeCtx({ octokit });
      const result = await fix(ctx);

      // Only 1 kiln-fix commit, so it should proceed (iteration 2)
      expect(result.status).toBe("success");
      expect(result.iteration).toBe(2);
    });
  });

  // ── Edge cases ──
  describe("edge cases", () => {
    it("handles reviews with no body", async () => {
      const octokit = makeOctokit();
      (octokit.rest.pulls.listReviews as unknown as jest.Mock).mockResolvedValue({
        data: [
          { state: "CHANGES_REQUESTED", body: null },
          { state: "CHANGES_REQUESTED", body: "" },
        ],
      });
      const ctx = makeCtx({ octokit });
      const result = await fix(ctx);
      expect(result.status).toBe("success");
    });

    it("handles different PR numbers correctly", async () => {
      const ctx = makeCtx({
        context: makeContext({ number: 42, title: "Fix login bug" }),
      });
      await fix(ctx);

      expect(ctx.octokit.rest.pulls.listReviews).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 42 }),
      );
      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("PR #42");
    });

    it("handles different branch names", async () => {
      const ctx = makeCtx({
        context: makeContext({
          head: { ref: "kiln/impl/issue-99" },
        }),
      });
      await fix(ctx);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git fetch origin kiln/impl/issue-99",
      );
      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout kiln/impl/issue-99",
      );
    });
  });
});
