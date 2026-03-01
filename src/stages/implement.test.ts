import implement from "./implement";
import { KilnContext, KilnConfig, Octokit } from "../types";
import { Context } from "@actions/github/lib/context";

jest.mock("@actions/core");
jest.mock("../claude");
jest.mock("../labels");
jest.mock("child_process", () => ({
  execSync: jest.fn().mockReturnValue(""),
}));

// Partial mock of fs: preserve promises (needed by @actions/core) but mock sync methods
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn(),
  };
});

import * as core from "@actions/core";
import { runClaudeEdit } from "../claude";
import { transitionLabel } from "../labels";
import { execSync } from "child_process";
import * as fs from "fs";

const mockedRunClaudeEdit = runClaudeEdit as unknown as jest.Mock;
const mockedTransitionLabel = transitionLabel as unknown as jest.Mock;
const mockedExecSync = execSync as unknown as jest.Mock;
const mockedExistsSync = fs.existsSync as unknown as jest.Mock;

function makeOctokit(): Octokit {
  return {
    rest: {
      pulls: {
        create: jest.fn().mockResolvedValue({
          data: { number: 20 },
        }),
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

function makeContext(issuePayload: Record<string, unknown> = {}): Context {
  return {
    eventName: "issues",
    payload: {
      action: "labeled",
      issue: {
        number: 5,
        title: "Add user authentication",
        body: "We need OAuth2 login support.",
        labels: [{ name: "kiln:implementing" }],
        ...issuePayload,
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
  mockedRunClaudeEdit.mockReturnValue("Implementation complete");
  mockedExecSync.mockReturnValue("");

  // By default, spec file exists (already merged from spec PR)
  mockedExistsSync.mockImplementation((path: string) => {
    if (path === "specs/issue-5.md") return true;
    return false;
  });
});

describe("implement", () => {
  // ── AC: Triggers when issue receives kiln:implementing label ──
  describe("triggers on kiln:implementing label", () => {
    it("processes an issue with kiln:implementing label", async () => {
      const ctx = makeCtx();
      const result = await implement(ctx);
      expect(result.status).toBe("success");
    });

    it("logs the issue number and title", async () => {
      const ctx = makeCtx();
      await implement(ctx);
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Issue #5: Add user authentication"),
      );
    });
  });

  // ── AC: Checks out the repo and reads the spec ──
  describe("checks out repo and reads spec", () => {
    it("fetches and checks out main branch first", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git fetch origin main && git checkout main && git pull origin main",
      );
    });

    it("checks that spec file exists at specs/issue-{number}.md", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(mockedExistsSync).toHaveBeenCalledWith("specs/issue-5.md");
    });

    it("fails if spec file does not exist", async () => {
      mockedExistsSync.mockReturnValue(false);
      const ctx = makeCtx();
      const result = await implement(ctx);

      expect(result.status).toBe("error");
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("Spec not found"),
      );
    });

    it("creates implementation branch kiln/impl/issue-{number}", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout -b kiln/impl/issue-5",
      );
    });

    it("configures git user before branching", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      const calls = mockedExecSync.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      const configNameIdx = calls.findIndex((c: string) =>
        c.includes("git config user.name"),
      );
      const configEmailIdx = calls.findIndex((c: string) =>
        c.includes("git config user.email"),
      );
      const checkoutBranchIdx = calls.findIndex((c: string) =>
        c.includes("git checkout -b kiln/impl"),
      );

      expect(configNameIdx).toBeLessThan(checkoutBranchIdx);
      expect(configEmailIdx).toBeLessThan(checkoutBranchIdx);
    });
  });

  // ── AC: Sends spec + codebase context to Claude with implementation prompt ──
  describe("sends spec to Claude", () => {
    it("invokes Claude in edit mode with runClaudeEdit", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(mockedRunClaudeEdit).toHaveBeenCalled();
    });

    it("prompt references the spec file path", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("specs/issue-5.md");
    });

    it("prompt includes issue title and number", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("Issue #5");
      expect(prompt).toContain("Add user authentication");
    });

    it("passes correct anthropicKey and timeout to runClaudeEdit", async () => {
      const ctx = makeCtx({
        anthropicKey: "sk-ant-custom",
        timeoutMinutes: 15,
      });
      await implement(ctx);

      expect(mockedRunClaudeEdit).toHaveBeenCalledWith(expect.any(String), {
        anthropicKey: "sk-ant-custom",
        timeoutMinutes: 15,
      });
    });
  });

  // ── AC: Claude implements on branch, follows conventions, conventional commits ──
  describe("implementation prompt instructions", () => {
    it("instructs Claude to follow project conventions from CLAUDE.md", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("conventions");
    });

    it("instructs Claude to write tests from the Test Plan", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toMatch(/tests?/i);
    });

    it("instructs Claude to run tests and lint", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toMatch(/test/i);
      expect(prompt).toMatch(/lint/i);
    });

    it("instructs Claude to use conventional commits", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("conventional commits");
    });

    it("instructs Claude to reference issue number in commits", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("#5");
    });

    it("includes protected paths in prompt", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain(".github/");
      expect(prompt).toContain("CLAUDE.md");
    });

    it("uses custom protected paths from config", async () => {
      const ctx = makeCtx({
        config: makeConfig({ protected_paths: ["secrets/", "deploy.yml"] }),
      });
      await implement(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("secrets/");
      expect(prompt).toContain("deploy.yml");
    });
  });

  // ── AC: Pushes implementation branch ──
  describe("pushes implementation branch", () => {
    it("pushes to origin with the implementation branch name", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git push origin kiln/impl/issue-5 --force",
      );
    });

    it("handles push failure gracefully (Claude may have already pushed)", async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git push")) {
          throw new Error("already pushed");
        }
        return "";
      });

      const ctx = makeCtx();
      const result = await implement(ctx);

      expect(result.status).toBe("success");
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Push failed"),
      );
    });
  });

  // ── AC: Opens PR titled "🔨 Kiln Impl: {issue title}" targeting main ──
  describe("creates implementation PR", () => {
    it('opens PR titled "🔨 Kiln Impl: {issue title}"', async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(ctx.octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          title: "🔨 Kiln Impl: Add user authentication",
          head: "kiln/impl/issue-5",
          base: "main",
        }),
      );
    });

    it("PR body references the spec file", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(ctx.octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("specs/issue-5.md"),
        }),
      );
    });

    it("PR body includes Closes #{issue_number}", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(ctx.octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Closes #5"),
        }),
      );
    });

    it("returns the PR number", async () => {
      const ctx = makeCtx();
      const result = await implement(ctx);

      expect(result.prNumber).toBe(20);
    });
  });

  // ── AC: PR is labeled with kiln:implementation and needs-review ──
  describe("PR labels", () => {
    it("labels PR with kiln:implementation and needs-review", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          issue_number: 20,
          labels: ["kiln:implementation", "needs-review"],
        }),
      );
    });

    it("uses custom label prefix for implementation label", async () => {
      const ctx = makeCtx({ config: makeConfig({}, "myapp") });
      await implement(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: ["myapp:implementation", "needs-review"],
        }),
      );
    });
  });

  // ── AC: Issue updated: kiln:implementing removed, kiln:in-review added ──
  describe("issue label transition", () => {
    it("transitions issue from implementing to in-review", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        ctx.octokit,
        ctx.context,
        5,
        "implementing",
        "in-review",
        "kiln",
      );
    });

    it("uses custom label prefix for transition", async () => {
      const ctx = makeCtx({ config: makeConfig({}, "myapp") });
      await implement(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        5,
        "implementing",
        "in-review",
        "myapp",
      );
    });
  });

  // ── AC: Comment posted on issue linking to the implementation PR ──
  describe("issue comment", () => {
    it("posts comment on issue linking to implementation PR", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          issue_number: 5,
          body: expect.stringContaining("#20"),
        }),
      );
    });

    it("comment is Kiln-branded", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("**Kiln**"),
        }),
      );
    });
  });

  // ── Edge cases ──
  describe("edge cases", () => {
    it("handles different issue numbers correctly", async () => {
      mockedExistsSync.mockImplementation((path: string) => {
        if (path === "specs/issue-42.md") return true;
        return false;
      });
      const ctx = makeCtx({
        context: makeContext({
          number: 42,
          title: "Fix login bug",
          body: "Login is broken.",
        }),
      });
      await implement(ctx);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout -b kiln/impl/issue-42",
      );
      expect(ctx.octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "🔨 Kiln Impl: Fix login bug",
          head: "kiln/impl/issue-42",
        }),
      );
    });

    it("returns success status when everything works", async () => {
      const ctx = makeCtx();
      const result = await implement(ctx);

      expect(result.status).toBe("success");
    });

    it("instructs Claude to commit and push", async () => {
      const ctx = makeCtx();
      await implement(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("commit");
      expect(prompt).toContain("push");
    });
  });
});
