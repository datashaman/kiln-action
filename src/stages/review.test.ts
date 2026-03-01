import review from "./review";
import { KilnContext, KilnConfig, Octokit } from "../types";
import { Context } from "@actions/github/lib/context";

jest.mock("@actions/core");
jest.mock("../claude");
jest.mock("child_process", () => ({
  execSync: jest.fn().mockReturnValue(""),
}));

// Partial mock of fs: preserve promises (needed by @actions/core) but mock sync methods
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
  };
});

import * as core from "@actions/core";
import { runClaude } from "../claude";
import { execSync } from "child_process";
import * as fs from "fs";

const mockedRunClaude = runClaude as unknown as jest.Mock;
const mockedExecSync = execSync as unknown as jest.Mock;
const mockedExistsSync = fs.existsSync as unknown as jest.Mock;
const mockedReadFileSync = fs.readFileSync as unknown as jest.Mock;

function makeOctokit(): Octokit {
  return {
    rest: {
      pulls: {
        get: jest.fn().mockResolvedValue({
          data: "diff --git a/src/foo.ts b/src/foo.ts\n+console.log('hello');",
        }),
        listFiles: jest.fn().mockResolvedValue({
          data: [
            {
              filename: "src/foo.ts",
              status: "modified",
              additions: 10,
              deletions: 2,
            },
            {
              filename: "src/bar.ts",
              status: "added",
              additions: 50,
              deletions: 0,
            },
          ],
        }),
        createReview: jest.fn().mockResolvedValue({}),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({}),
        addLabels: jest.fn().mockResolvedValue({}),
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
    eventName: "pull_request",
    payload: {
      action: "opened",
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

const approveResponse = JSON.stringify({
  verdict: "approve",
  summary: "Implementation looks great. All acceptance criteria met.",
  issues: [],
});

const changesResponse = JSON.stringify({
  verdict: "request_changes",
  summary: "Found some issues that need to be addressed.",
  issues: [
    {
      file: "src/foo.ts",
      line: 42,
      severity: "critical",
      comment: "Missing input validation on user data",
    },
    {
      file: "src/bar.ts",
      line: 10,
      severity: "major",
      comment: "Error is silently swallowed",
    },
    {
      file: "src/foo.ts",
      line: 100,
      severity: "minor",
      comment: "Consider using a constant for this magic number",
    },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedExecSync.mockReturnValue("");
  mockedRunClaude.mockResolvedValue(`\`\`\`json\n${approveResponse}\n\`\`\``);
  mockedExistsSync.mockReturnValue(true);
  mockedReadFileSync.mockReturnValue(
    "# Spec\n## Requirements\n- Must support OAuth2",
  );
});

describe("review", () => {
  // ── AC1: Triggers on pull_request.opened and pull_request.synchronize ──
  describe("triggers on PR events", () => {
    it("processes a PR opened event", async () => {
      const ctx = makeCtx();
      const result = await review(ctx);
      expect(result.status).toBe("success");
    });

    it("processes a PR synchronize event", async () => {
      const ctx = makeCtx({
        context: makeContext({ action: "synchronize" } as unknown as Record<string, unknown>),
      });
      // Wrap in a new context that uses synchronize action
      const syncContext = {
        ...ctx.context,
        payload: { ...ctx.context.payload, action: "synchronize" },
      } as unknown as Context;
      const result = await review({ ...ctx, context: syncContext });
      expect(result.status).toBe("success");
    });

    it("logs the PR number and title", async () => {
      const ctx = makeCtx();
      await review(ctx);
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "PR #10: 🔨 Kiln Impl: Add user authentication",
        ),
      );
    });
  });

  // ── AC3: Checks out the repo with full history (fetch-depth: 0) ──
  describe("checks out repo with full history", () => {
    it("fetches full history (unshallow or fetch)", async () => {
      const ctx = makeCtx();
      await review(ctx);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git fetch --unshallow || git fetch",
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });

    it("checks out the PR head branch", async () => {
      const ctx = makeCtx();
      await review(ctx);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout kiln/impl/issue-5",
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });

    it("fetches before checking out the branch", async () => {
      const ctx = makeCtx();
      await review(ctx);

      const calls = mockedExecSync.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      const fetchIdx = calls.findIndex((c: string) =>
        c.includes("git fetch"),
      );
      const checkoutIdx = calls.findIndex((c: string) =>
        c.includes("git checkout"),
      );

      expect(fetchIdx).toBeLessThan(checkoutIdx);
    });
  });

  // ── AC4: Claude reads the referenced spec and reviews against acceptance criteria ──
  describe("reads spec and sends to Claude", () => {
    it("extracts issue number from PR body (Closes #N)", async () => {
      const ctx = makeCtx();
      await review(ctx);

      expect(mockedExistsSync).toHaveBeenCalledWith("specs/issue-5.md");
    });

    it("reads the spec file content", async () => {
      const ctx = makeCtx();
      await review(ctx);

      expect(mockedReadFileSync).toHaveBeenCalledWith(
        "specs/issue-5.md",
        "utf-8",
      );
    });

    it("includes spec content in the prompt", async () => {
      const ctx = makeCtx();
      await review(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Must support OAuth2");
      expect(prompt).toContain("Spec Content");
    });

    it("handles missing spec file gracefully", async () => {
      mockedExistsSync.mockReturnValue(false);
      const ctx = makeCtx();
      const result = await review(ctx);

      expect(result.status).toBe("success");
      expect(mockedReadFileSync).not.toHaveBeenCalled();
    });

    it("handles PR without Closes #N in body", async () => {
      const ctx = makeCtx({
        context: makeContext({
          body: "Some PR without issue reference",
        }),
      });
      const result = await review(ctx);

      expect(result.status).toBe("success");
      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).not.toContain("Spec Content");
    });

    it("fetches the diff via GitHub API", async () => {
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.get).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          pull_number: 10,
          mediaType: { format: "diff" },
        }),
      );
    });

    it("fetches file list via GitHub API", async () => {
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.listFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          pull_number: 10,
          per_page: 100,
        }),
      );
    });

    it("includes file list in prompt", async () => {
      const ctx = makeCtx();
      await review(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("src/foo.ts");
      expect(prompt).toContain("src/bar.ts");
    });

    it("includes diff in prompt", async () => {
      const ctx = makeCtx();
      await review(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("console.log");
    });
  });

  // ── AC5: Review covers correctness, security, performance, error handling, test coverage, style consistency ──
  describe("review covers required areas", () => {
    it("prompt covers correctness", async () => {
      const ctx = makeCtx();
      await review(ctx);
      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Correctness");
    });

    it("prompt covers security", async () => {
      const ctx = makeCtx();
      await review(ctx);
      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Security");
    });

    it("prompt covers performance", async () => {
      const ctx = makeCtx();
      await review(ctx);
      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Performance");
    });

    it("prompt covers error handling", async () => {
      const ctx = makeCtx();
      await review(ctx);
      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Error handling");
    });

    it("prompt covers test coverage (completeness)", async () => {
      const ctx = makeCtx();
      await review(ctx);
      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Completeness");
      expect(prompt).toMatch(/tests?\s*written/i);
    });

    it("prompt covers code style consistency", async () => {
      const ctx = makeCtx();
      await review(ctx);
      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Code style");
    });

    it("passes correct anthropicKey and timeout to runClaude", async () => {
      const ctx = makeCtx({
        anthropicKey: "sk-ant-custom",
        timeoutMinutes: 15,
      });
      await review(ctx);

      expect(mockedRunClaude).toHaveBeenCalledWith(expect.any(String), {
        anthropicKey: "sk-ant-custom",
        timeoutMinutes: 15,
      });
    });
  });

  // ── AC6: If everything passes, Claude approves the PR ──
  describe("approves PR when no issues", () => {
    it("posts an APPROVE review when verdict is approve", async () => {
      mockedRunClaude.mockResolvedValue(
        `\`\`\`json\n${approveResponse}\n\`\`\``,
      );
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          pull_number: 10,
          event: "APPROVE",
        }),
      );
    });

    it("returns verdict approve in result", async () => {
      mockedRunClaude.mockResolvedValue(
        `\`\`\`json\n${approveResponse}\n\`\`\``,
      );
      const ctx = makeCtx();
      const result = await review(ctx);

      expect(result.verdict).toBe("approve");
    });
  });

  // ── AC7: If issues found, Claude requests changes with inline comments ──
  describe("requests changes when issues found", () => {
    it("posts a REQUEST_CHANGES review when verdict is request_changes", async () => {
      mockedRunClaude.mockResolvedValue(
        `\`\`\`json\n${changesResponse}\n\`\`\``,
      );
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          pull_number: 10,
          event: "REQUEST_CHANGES",
        }),
      );
    });

    it("includes inline comments for each issue", async () => {
      mockedRunClaude.mockResolvedValue(
        `\`\`\`json\n${changesResponse}\n\`\`\``,
      );
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          comments: expect.arrayContaining([
            expect.objectContaining({
              path: "src/foo.ts",
              line: 42,
              body: expect.stringContaining("Missing input validation"),
            }),
          ]),
        }),
      );
    });

    it("includes severity in inline comment body", async () => {
      mockedRunClaude.mockResolvedValue(
        `\`\`\`json\n${changesResponse}\n\`\`\``,
      );
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          comments: expect.arrayContaining([
            expect.objectContaining({
              body: expect.stringContaining("**critical:**"),
            }),
          ]),
        }),
      );
    });

    it("returns verdict request_changes in result", async () => {
      mockedRunClaude.mockResolvedValue(
        `\`\`\`json\n${changesResponse}\n\`\`\``,
      );
      const ctx = makeCtx();
      const result = await review(ctx);

      expect(result.verdict).toBe("request_changes");
    });

    it("review body includes issue counts by severity", async () => {
      mockedRunClaude.mockResolvedValue(
        `\`\`\`json\n${changesResponse}\n\`\`\``,
      );
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("3"),
        }),
      );
    });
  });

  // ── AC8: Review is posted as a proper GitHub PR review ──
  describe("posts as proper PR review", () => {
    it("uses pulls.createReview (not issues.createComment)", async () => {
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.createReview).toHaveBeenCalled();
      expect(ctx.octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("review body is Kiln-branded", async () => {
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("🔥 **Kiln Review**"),
        }),
      );
    });

    it("review body includes summary from Claude", async () => {
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            "Implementation looks great",
          ),
        }),
      );
    });
  });

  // ── Edge cases ──
  describe("edge cases", () => {
    it("falls back to raw JSON parsing when no code block", async () => {
      mockedRunClaude.mockResolvedValue(approveResponse);
      const ctx = makeCtx();
      const result = await review(ctx);

      expect(result.status).toBe("success");
      expect(result.verdict).toBe("approve");
    });

    it("posts raw output as COMMENT when JSON parsing fails", async () => {
      mockedRunClaude.mockResolvedValue("This is not JSON at all.");
      const ctx = makeCtx();
      const result = await review(ctx);

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse review response"),
      );
      expect(ctx.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("This is not JSON at all."),
          event: "COMMENT",
        }),
      );
      expect(result.status).toBe("success");
    });

    it("falls back to summary review when inline comments fail", async () => {
      mockedRunClaude.mockResolvedValue(
        `\`\`\`json\n${changesResponse}\n\`\`\``,
      );
      const octokit = makeOctokit();
      (octokit.rest.pulls.createReview as unknown as jest.Mock)
        .mockRejectedValueOnce(new Error("Validation failed"))
        .mockResolvedValueOnce({});

      const ctx = makeCtx({ octokit });
      await review(ctx);

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Inline comments failed"),
      );
      // Second call should be the fallback without inline comments
      expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(2);
      const secondCall = (octokit.rest.pulls.createReview as unknown as jest.Mock).mock
        .calls[1][0];
      expect(secondCall.body).toContain("src/foo.ts:42");
    });

    it("does not pass comments when there are no issues", async () => {
      mockedRunClaude.mockResolvedValue(
        `\`\`\`json\n${approveResponse}\n\`\`\``,
      );
      const ctx = makeCtx();
      await review(ctx);

      expect(ctx.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          comments: undefined,
        }),
      );
    });

    it("handles different PR numbers correctly", async () => {
      const ctx = makeCtx({
        context: makeContext({ number: 99, title: "Fix login bug" }),
      });
      await review(ctx);

      expect(ctx.octokit.rest.pulls.get).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 99 }),
      );
      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("PR #99");
    });

    it("truncates diff to 50000 characters", async () => {
      const longDiff = "x".repeat(60000);
      const octokit = makeOctokit();
      (octokit.rest.pulls.get as unknown as jest.Mock).mockResolvedValue({
        data: longDiff,
      });
      const ctx = makeCtx({ octokit });
      await review(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      // Diff should be truncated — prompt should not contain the full 60k chars
      expect(prompt.length).toBeLessThan(60000);
    });

    it("case-insensitive matching of Closes #N", async () => {
      const ctx = makeCtx({
        context: makeContext({
          body: "closes #7",
        }),
      });
      mockedExistsSync.mockImplementation((path: string) => {
        return path === "specs/issue-7.md";
      });
      await review(ctx);

      expect(mockedExistsSync).toHaveBeenCalledWith("specs/issue-7.md");
    });
  });
});
