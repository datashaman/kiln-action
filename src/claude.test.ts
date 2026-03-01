import { invokeClaude, runClaude, runClaudeEdit, ClaudeConfig } from "./claude";
import { Context } from "@actions/github/lib/context";
import { Octokit } from "./types";

jest.mock("@actions/core");
jest.mock("child_process");

import * as core from "@actions/core";
import { execSync } from "child_process";

const mockedExecSync = execSync as unknown as jest.Mock;

function makeOctokit(): Octokit {
  return {
    rest: {
      issues: {
        createComment: jest.fn().mockResolvedValue({}),
      },
    },
  } as unknown as Octokit;
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

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

// ── invokeClaude ──────────────────────────────────────

describe("invokeClaude", () => {
  describe("accepts prompt, API key, and optional config", () => {
    it("passes prompt and returns output", async () => {
      mockedExecSync.mockReturnValue("  Claude says hello  ");

      const result = await invokeClaude("Hello Claude", {
        anthropicKey: "sk-ant-test-key",
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("Claude says hello");
    });

    it("accepts optional configuration (timeout, allowEdits, octokit, context)", async () => {
      mockedExecSync.mockReturnValue("output");
      const octokit = makeOctokit();
      const context = makeContext("issues", { issue: { number: 1 } });

      const config: ClaudeConfig = {
        anthropicKey: "sk-ant-test",
        timeoutMinutes: 15,
        allowEdits: true,
        octokit,
        context,
      };

      const result = await invokeClaude("test prompt", config);
      expect(result.success).toBe(true);
    });
  });

  describe("invokes Claude CLI with correct flags", () => {
    it("uses --print flag for read-only mode by default", async () => {
      mockedExecSync.mockReturnValue("output");

      await invokeClaude("Review this code", {
        anthropicKey: "sk-ant-test",
      });

      expect(mockedExecSync).toHaveBeenCalledWith(
        "claude --print --dangerously-skip-permissions",
        expect.objectContaining({
          input: "Review this code",
        }),
      );
    });

    it("omits --print flag when allowEdits is true", async () => {
      mockedExecSync.mockReturnValue("output");

      await invokeClaude("Fix this bug", {
        anthropicKey: "sk-ant-test",
        allowEdits: true,
      });

      expect(mockedExecSync).toHaveBeenCalledWith(
        "claude --dangerously-skip-permissions",
        expect.objectContaining({
          input: "Fix this bug",
        }),
      );
    });
  });

  describe("captures and returns output", () => {
    it("returns trimmed output in ClaudeResult", async () => {
      mockedExecSync.mockReturnValue('\n  { "type": "bug" }  \n');

      const result = await invokeClaude("triage", {
        anthropicKey: "sk-ant-test",
      });

      expect(result.output).toBe('{ "type": "bug" }');
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("handles timeouts", () => {
    it("returns specific timeout error message on ETIMEDOUT", async () => {
      const error = new Error("Command timed out");
      (error as NodeJS.ErrnoException).code = "ETIMEDOUT";
      mockedExecSync.mockImplementation(() => { throw error; });

      const result = await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
        timeoutMinutes: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Claude Code timed out after 10 minutes");
    });
  });

  describe("handles errors and surfaces them as comments", () => {
    it("returns error result on CLI error", async () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("CLI not found");
      });

      const result = await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("CLI not found");
      expect(result.output).toBe("");
    });

    it("posts error comment on issue when octokit and context provided", async () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("API rate limited");
      });

      const octokit = makeOctokit();
      const context = makeContext("issues", {
        issue: { number: 42 },
      });

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
        octokit,
        context,
      });

      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 42,
        body: expect.stringContaining("API rate limited"),
      });
    });

    it("posts error comment on PR when context has pull_request", async () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("Network error");
      });

      const octokit = makeOctokit();
      const context = makeContext("pull_request", {
        pull_request: { number: 99 },
      });

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
        octokit,
        context,
      });

      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 99 }),
      );
    });

    it("does not throw when comment posting fails", async () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("fail");
      });

      const octokit = makeOctokit();
      (octokit.rest.issues.createComment as unknown as jest.Mock).mockRejectedValue(
        new Error("Forbidden"),
      );
      const context = makeContext("issues", { issue: { number: 1 } });

      const result = await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
        octokit,
        context,
      });

      // Should not throw, just return error result
      expect(result.success).toBe(false);
    });

    it("skips posting comment when no octokit/context provided", async () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("fail");
      });

      const result = await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
      });

      expect(result.success).toBe(false);
      // No crash, no comment posted
    });

    it("skips posting comment when context has no issue or PR", async () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("fail");
      });

      const octokit = makeOctokit();
      const context = makeContext("push", {});

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
        octokit,
        context,
      });

      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("error comment is branded with Kiln prefix", async () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("something broke");
      });

      const octokit = makeOctokit();
      const context = makeContext("issues", { issue: { number: 1 } });

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
        octokit,
        context,
      });

      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringMatching(/^🔥 \*\*Kiln\*\*/),
        }),
      );
    });
  });

  describe("API key security", () => {
    it("passes API key via env, not in prompt", async () => {
      mockedExecSync.mockReturnValue("output");

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-secret-key-12345",
      });

      const callArgs = mockedExecSync.mock.calls[0];

      // API key must NOT appear in the command
      expect(callArgs[0]).not.toContain("sk-ant-secret-key-12345");
      // API key must NOT appear in stdin input
      expect(callArgs[1].input).not.toContain("sk-ant-secret-key-12345");
      // API key must be in env
      expect(callArgs[1].env.ANTHROPIC_API_KEY).toBe("sk-ant-secret-key-12345");
    });

    it("redacts API key from error comments", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-leaked-key";
      mockedExecSync.mockImplementation(() => {
        throw new Error("Error: invalid key sk-ant-leaked-key at endpoint");
      });

      const octokit = makeOctokit();
      const context = makeContext("issues", { issue: { number: 1 } });

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-leaked-key",
        octokit,
        context,
      });

      const commentCall = (
        octokit.rest.issues.createComment as unknown as jest.Mock
      ).mock.calls[0][0];

      // The API key should be redacted in the comment body
      expect(commentCall.body).not.toContain("sk-ant-leaked-key");
      expect(commentCall.body).toContain("[REDACTED]");
    });
  });

  describe("uses --dangerously-skip-permissions flag", () => {
    it("always includes the flag in the command", async () => {
      mockedExecSync.mockReturnValue("output");

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
      });

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("--dangerously-skip-permissions"),
        expect.anything(),
      );
    });
  });
});

// ── runClaude (convenience wrapper) ────────────

describe("runClaude", () => {
  it("returns trimmed output", async () => {
    mockedExecSync.mockReturnValue("  result  ");
    const result = await runClaude("prompt", { anthropicKey: "sk-ant-test" });
    expect(result).toBe("result");
  });

  it("uses --print flag for read-only mode", async () => {
    mockedExecSync.mockReturnValue("ok");
    await runClaude("test prompt", { anthropicKey: "sk-ant-test" });
    expect(mockedExecSync).toHaveBeenCalledWith(
      "claude --print --dangerously-skip-permissions",
      expect.objectContaining({
        input: "test prompt",
      }),
    );
  });

  it("throws on CLI failure", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("CLI error");
    });
    await expect(
      runClaude("prompt", { anthropicKey: "sk-ant-test" }),
    ).rejects.toThrow("CLI error");
    expect(core.error).toHaveBeenCalled();
  });

  it("passes API key via env", async () => {
    mockedExecSync.mockReturnValue("ok");
    await runClaude("prompt", { anthropicKey: "sk-ant-key" });
    const options = mockedExecSync.mock.calls[0][1];
    expect(options.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
  });
});

// ── runClaudeEdit (convenience wrapper) ────────

describe("runClaudeEdit", () => {
  it("returns trimmed output", async () => {
    mockedExecSync.mockReturnValue("  result  ");
    const result = await runClaudeEdit("prompt", { anthropicKey: "sk-ant-test" });
    expect(result).toBe("result");
  });

  it("uses edit mode (no --print flag)", async () => {
    mockedExecSync.mockReturnValue("ok");
    await runClaudeEdit("edit prompt", { anthropicKey: "sk-ant-test" });
    expect(mockedExecSync).toHaveBeenCalledWith(
      "claude --dangerously-skip-permissions",
      expect.objectContaining({
        input: "edit prompt",
      }),
    );
  });

  it("throws on CLI failure", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("edit error");
    });
    await expect(
      runClaudeEdit("prompt", { anthropicKey: "sk-ant-test" }),
    ).rejects.toThrow("edit error");
    expect(core.error).toHaveBeenCalled();
  });

  it("passes API key via env", async () => {
    mockedExecSync.mockReturnValue("ok");
    await runClaudeEdit("prompt", { anthropicKey: "sk-ant-key" });
    const options = mockedExecSync.mock.calls[0][1];
    expect(options.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
  });
});
