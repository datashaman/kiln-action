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

  describe("invokes Claude CLI with the prompt", () => {
    it("uses --print mode by default (read-only)", async () => {
      mockedExecSync.mockReturnValue("output");

      await invokeClaude("Review this code", {
        anthropicKey: "sk-ant-test",
      });

      expect(mockedExecSync).toHaveBeenCalledWith(
        "claude --print",
        expect.objectContaining({ input: "Review this code" }),
      );
    });

    it("uses edit mode when allowEdits is true", async () => {
      mockedExecSync.mockReturnValue("output");

      await invokeClaude("Fix this bug", {
        anthropicKey: "sk-ant-test",
        allowEdits: true,
      });

      expect(mockedExecSync).toHaveBeenCalledWith(
        "claude",
        expect.objectContaining({ input: "Fix this bug" }),
      );
    });
  });

  describe("captures and returns output", () => {
    it("returns trimmed output in ClaudeResult", async () => {
      mockedExecSync.mockReturnValue("\n  { \"type\": \"bug\" }  \n");

      const result = await invokeClaude("triage", {
        anthropicKey: "sk-ant-test",
      });

      expect(result.output).toBe('{ "type": "bug" }');
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("handles timeouts", () => {
    it("defaults to 30 minutes timeout", async () => {
      mockedExecSync.mockReturnValue("ok");

      await invokeClaude("prompt", { anthropicKey: "sk-ant-test" });

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          timeout: 30 * 60 * 1000,
        }),
      );
    });

    it("uses custom timeout when specified", async () => {
      mockedExecSync.mockReturnValue("ok");

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
        timeoutMinutes: 15,
      });

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          timeout: 15 * 60 * 1000,
        }),
      );
    });

    it("returns specific timeout error message when killed", async () => {
      const error = new Error("Command timed out");
      (error as NodeJS.ErrnoException & { killed?: boolean }).killed = true;
      mockedExecSync.mockImplementation(() => {
        throw error;
      });

      const result = await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
        timeoutMinutes: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Claude Code timed out after 10 minutes");
    });
  });

  describe("handles errors and surfaces them as comments", () => {
    it("returns error result on failure", async () => {
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
    it("passes API key via environment variable, not in command", async () => {
      mockedExecSync.mockReturnValue("output");

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-secret-key-12345",
      });

      const callArgs = mockedExecSync.mock.calls[0];
      const command = callArgs[0] as string;
      const options = callArgs[1] as { env: Record<string, string> };

      // API key must NOT appear in the command string
      expect(command).not.toContain("sk-ant-secret-key-12345");
      // API key must be in env
      expect(options.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret-key-12345");
    });

    it("redacts API key from error comments", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-leaked-key";
      mockedExecSync.mockImplementation(() => {
        throw new Error(
          "Error: invalid key sk-ant-leaked-key at endpoint",
        );
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

  describe("passes prompt via stdin", () => {
    it("passes prompt as input option, not in command string", async () => {
      mockedExecSync.mockReturnValue("ok");

      await invokeClaude('Say "hello" with $vars and `backticks`', {
        anthropicKey: "sk-ant-test",
      });

      const callArgs = mockedExecSync.mock.calls[0];
      const command = callArgs[0] as string;
      const options = callArgs[1] as { input: string };

      // Prompt must NOT appear in command string
      expect(command).not.toContain("hello");
      // Prompt must be passed via stdin input
      expect(options.input).toBe('Say "hello" with $vars and `backticks`');
    });
  });
});

// ── runClaude (legacy convenience wrapper) ────────────

describe("runClaude", () => {
  it("returns trimmed output", () => {
    mockedExecSync.mockReturnValue("  result  ");
    const result = runClaude("prompt", { anthropicKey: "sk-ant-test" });
    expect(result).toBe("result");
  });

  it("uses --print mode and passes prompt via stdin", () => {
    mockedExecSync.mockReturnValue("ok");
    runClaude("test prompt", { anthropicKey: "sk-ant-test" });
    expect(mockedExecSync).toHaveBeenCalledWith(
      "claude --print",
      expect.objectContaining({ input: "test prompt" }),
    );
  });

  it("throws on CLI failure", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("CLI error");
    });
    expect(() =>
      runClaude("prompt", { anthropicKey: "sk-ant-test" }),
    ).toThrow("CLI error");
    expect(core.error).toHaveBeenCalled();
  });

  it("passes API key via env", () => {
    mockedExecSync.mockReturnValue("ok");
    runClaude("prompt", { anthropicKey: "sk-ant-key" });
    const options = mockedExecSync.mock.calls[0][1];
    expect(options.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
  });

  it("defaults to 30 minute timeout", () => {
    mockedExecSync.mockReturnValue("ok");
    runClaude("prompt", { anthropicKey: "sk-ant-test" });
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 30 * 60 * 1000 }),
    );
  });
});

// ── runClaudeEdit (legacy convenience wrapper) ────────

describe("runClaudeEdit", () => {
  it("returns trimmed output", () => {
    mockedExecSync.mockReturnValue("  result  ");
    const result = runClaudeEdit("prompt", { anthropicKey: "sk-ant-test" });
    expect(result).toBe("result");
  });

  it("does NOT use --print mode and passes prompt via stdin", () => {
    mockedExecSync.mockReturnValue("ok");
    runClaudeEdit("edit prompt", { anthropicKey: "sk-ant-test" });
    expect(mockedExecSync).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ input: "edit prompt" }),
    );
  });

  it("throws on CLI failure", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("edit error");
    });
    expect(() =>
      runClaudeEdit("prompt", { anthropicKey: "sk-ant-test" }),
    ).toThrow("edit error");
    expect(core.error).toHaveBeenCalled();
  });

  it("passes API key via env", () => {
    mockedExecSync.mockReturnValue("ok");
    runClaudeEdit("prompt", { anthropicKey: "sk-ant-key" });
    const options = mockedExecSync.mock.calls[0][1];
    expect(options.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
  });
});
