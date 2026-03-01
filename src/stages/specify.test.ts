import specify from "./specify";
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
    mkdirSync: jest.fn(),
    readFileSync: jest.fn(),
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
const mockedMkdirSync = fs.mkdirSync as unknown as jest.Mock;
const mockedReadFileSync = fs.readFileSync as unknown as jest.Mock;

function makeOctokit(): Octokit {
  return {
    rest: {
      pulls: {
        create: jest.fn().mockResolvedValue({
          data: { number: 10 },
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
        labels: [{ name: "kiln:specifying" }],
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
  mockedRunClaudeEdit.mockReturnValue("Spec created successfully");
  mockedExecSync.mockReturnValue("");
  mockedMkdirSync.mockReturnValue(undefined);

  // By default, spec file exists after Claude creates it
  mockedExistsSync.mockImplementation((path: string) => {
    if (path === "specs/issue-5.md") return true;
    return false;
  });
});

describe("specify", () => {
  // ── AC: Triggers when issue receives kiln:specifying label ──
  describe("triggers on kiln:specifying label", () => {
    it("processes an issue with kiln:specifying label", async () => {
      const ctx = makeCtx();
      const result = await specify(ctx);
      expect(result.status).toBe("success");
    });

    it("logs the issue number and title", async () => {
      const ctx = makeCtx();
      await specify(ctx);
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Issue #5: Add user authentication"),
      );
    });
  });

  // ── AC: Checks out the repo and sends issue context to Claude ──
  describe("checks out repo and invokes Claude", () => {
    it("creates a spec branch kiln/spec/issue-{number}", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout -b kiln/spec/issue-5",
      );
    });

    it("configures git user before branching", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      const calls = mockedExecSync.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      const configNameIdx = calls.findIndex((c: string) =>
        c.includes("git config user.name"),
      );
      const configEmailIdx = calls.findIndex((c: string) =>
        c.includes("git config user.email"),
      );
      const checkoutIdx = calls.findIndex((c: string) =>
        c.includes("git checkout"),
      );

      expect(configNameIdx).toBeLessThan(checkoutIdx);
      expect(configEmailIdx).toBeLessThan(checkoutIdx);
    });

    it("creates specs directory", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(mockedMkdirSync).toHaveBeenCalledWith("specs", {
        recursive: true,
      });
    });

    it("sends issue title and body to Claude via runClaudeEdit", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(mockedRunClaudeEdit).toHaveBeenCalledWith(
        expect.stringContaining("Add user authentication"),
        expect.objectContaining({
          anthropicKey: "sk-ant-test-key",
          timeoutMinutes: 30,
        }),
      );

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("We need OAuth2 login support.");
    });

    it("includes issue number in the prompt", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("Issue #5");
    });

    it("handles empty issue body", async () => {
      mockedExistsSync.mockImplementation((path: string) => {
        if (path === "specs/issue-7.md") return true;
        return false;
      });
      const ctx = makeCtx({
        context: makeContext({ number: 7, title: "Bug", body: null }),
      });
      await specify(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("(empty)");
    });

    it("invokes Claude in edit mode (not read-only)", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(mockedRunClaudeEdit).toHaveBeenCalled();
    });
  });

  // ── AC: Claude creates spec file with required sections ──
  describe("spec file creation", () => {
    it("instructs Claude to create spec at specs/issue-{number}.md", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("specs/issue-5.md");
    });

    it("includes spec template with all required sections in prompt", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("Overview");
      expect(prompt).toContain("Requirements");
      expect(prompt).toContain("Technical Design");
      expect(prompt).toContain("Test Plan");
      expect(prompt).toContain("Out of Scope");
      expect(prompt).toContain("Implementation Notes");
    });

    it("verifies spec file was created after Claude runs", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(mockedExistsSync).toHaveBeenCalledWith("specs/issue-5.md");
    });

    it("fails if spec file was not created", async () => {
      mockedExistsSync.mockReturnValue(false);
      const ctx = makeCtx();
      const result = await specify(ctx);

      expect(result.status).toBe("error");
      expect(core.setFailed).toHaveBeenCalledWith(
        "Spec agent did not create specs/issue-5.md",
      );
    });
  });

  // ── AC: Custom spec template ──
  describe("custom spec template", () => {
    it("uses custom spec template from config.spec_template", async () => {
      mockedExistsSync.mockImplementation((path: string) => {
        if (path === "custom-template.md") return true;
        if (path === "specs/issue-5.md") return true;
        return false;
      });
      mockedReadFileSync.mockReturnValue("# Custom Template\n## My Section");

      const ctx = makeCtx({
        config: makeConfig({ spec_template: "custom-template.md" }),
      });
      await specify(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("# Custom Template");
      expect(prompt).toContain("## My Section");
    });

    it("uses custom spec template from config.agents.spec.template", async () => {
      mockedExistsSync.mockImplementation((path: string) => {
        if (path === "agent-template.md") return true;
        if (path === "specs/issue-5.md") return true;
        return false;
      });
      mockedReadFileSync.mockReturnValue("# Agent Template");

      const ctx = makeCtx({
        config: makeConfig({
          agents: {
            spec: { enabled: true, template: "agent-template.md" },
          } as KilnConfig["agents"],
        }),
      });
      await specify(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("# Agent Template");
    });

    it("falls back to default template when custom path does not exist", async () => {
      mockedExistsSync.mockImplementation((path: string) => {
        if (path === "nonexistent.md") return false;
        if (path === "specs/issue-5.md") return true;
        return false;
      });

      const ctx = makeCtx({
        config: makeConfig({ spec_template: "nonexistent.md" }),
      });
      await specify(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("Overview");
      expect(prompt).toContain("Requirements");
    });
  });

  // ── AC: Claude commits spec to branch and pushes ──
  describe("commits and pushes spec branch", () => {
    it("commits the spec file", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      const calls = mockedExecSync.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      const commitCall = calls.find((c: string) => c.includes("git commit"));
      expect(commitCall).toBeDefined();
      expect(commitCall).toContain("docs: add spec for issue #5");
    });

    it("pushes the branch to origin", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git push origin kiln/spec/issue-5 --force",
      );
    });

    it("handles already-committed case gracefully", async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (
          typeof cmd === "string" &&
          (cmd.includes("git add") || cmd.includes("git commit"))
        ) {
          throw new Error("nothing to commit");
        }
        return "";
      });

      const ctx = makeCtx();
      const result = await specify(ctx);
      expect(result.status).toBe("success");
    });
  });

  // ── AC: Opens PR titled "📋 Kiln Spec: {issue title}" ──
  describe("creates spec PR", () => {
    it('opens PR titled "📋 Kiln Spec: {issue title}"', async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(ctx.octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          title: "📋 Kiln Spec: Add user authentication",
          head: "kiln/spec/issue-5",
          base: "main",
        }),
      );
    });

    it("PR body references the issue number", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(ctx.octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("#5"),
        }),
      );
    });

    it("PR body includes review instructions", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(ctx.octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            "Approve this PR to trigger implementation",
          ),
        }),
      );
    });

    it("returns the PR number", async () => {
      const ctx = makeCtx();
      const result = await specify(ctx);

      expect(result.prNumber).toBe(10);
    });
  });

  // ── AC: PR is labeled with kiln:spec and needs-human-review ──
  describe("PR labels", () => {
    it("labels PR with kiln:spec and needs-human-review", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          issue_number: 10,
          labels: ["kiln:spec", "needs-human-review"],
        }),
      );
    });

    it("uses custom label prefix for spec label", async () => {
      const ctx = makeCtx({ config: makeConfig({}, "myapp") });
      await specify(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: ["myapp:spec", "needs-human-review"],
        }),
      );
    });
  });

  // ── AC: Issue updated: kiln:specifying removed, kiln:spec-review added ──
  describe("issue label transition", () => {
    it("transitions issue from specifying to spec-review", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        ctx.octokit,
        ctx.context,
        5,
        "specifying",
        "spec-review",
        "kiln",
      );
    });

    it("uses custom label prefix for transition", async () => {
      const ctx = makeCtx({ config: makeConfig({}, "myapp") });
      await specify(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        5,
        "specifying",
        "spec-review",
        "myapp",
      );
    });
  });

  // ── AC: Comment posted on issue linking to spec PR ──
  describe("issue comment", () => {
    it("posts comment on issue linking to spec PR", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          issue_number: 5,
          body: expect.stringContaining("#10"),
        }),
      );
    });

    it("comment is Kiln-branded", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("**Kiln**"),
        }),
      );
    });

    it("comment mentions spec review", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("review"),
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
      await specify(ctx);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout -b kiln/spec/issue-42",
      );
      expect(ctx.octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "📋 Kiln Spec: Fix login bug",
          head: "kiln/spec/issue-42",
        }),
      );
    });

    it("instructs Claude to commit and push", async () => {
      const ctx = makeCtx();
      await specify(ctx);

      const prompt = mockedRunClaudeEdit.mock.calls[0][0] as string;
      expect(prompt).toContain("commit");
      expect(prompt).toContain("push");
    });

    it("passes correct anthropicKey and timeout to runClaudeEdit", async () => {
      const ctx = makeCtx({
        anthropicKey: "sk-ant-custom",
        timeoutMinutes: 15,
      });
      await specify(ctx);

      expect(mockedRunClaudeEdit).toHaveBeenCalledWith(expect.any(String), {
        anthropicKey: "sk-ant-custom",
        timeoutMinutes: 15,
      });
    });

    it("returns success status when everything works", async () => {
      const ctx = makeCtx();
      const result = await specify(ctx);

      expect(result.status).toBe("success");
    });
  });
});
