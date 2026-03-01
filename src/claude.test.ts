import { invokeClaude, runClaude, runClaudeEdit, ClaudeConfig } from "./claude";
import { Context } from "@actions/github/lib/context";
import { Octokit } from "./types";

jest.mock("@actions/core");
jest.mock("@anthropic-ai/claude-agent-sdk");

import * as core from "@actions/core";
import { query } from "@anthropic-ai/claude-agent-sdk";

const mockedQuery = query as unknown as jest.Mock;

/**
 * Helper: create a mock async generator that yields a successful SDKResultMessage.
 */
function mockQuerySuccess(text: string) {
  async function* gen() {
    yield {
      type: "result" as const,
      subtype: "success" as const,
      result: text,
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 80,
      num_turns: 1,
      stop_reason: "end_turn",
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 20 },
      modelUsage: {},
      permission_denials: [],
      uuid: "test-uuid",
      session_id: "test-session",
    };
  }
  return gen();
}

/**
 * Helper: create a mock async generator that yields an error SDKResultMessage.
 */
function mockQueryError(errors: string[]) {
  async function* gen() {
    yield {
      type: "result" as const,
      subtype: "error_during_execution" as const,
      errors,
      is_error: true,
      duration_ms: 100,
      duration_api_ms: 80,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: "test-uuid",
      session_id: "test-session",
    };
  }
  return gen();
}

/**
 * Helper: create a mock async generator that yields no result message.
 */
function mockQueryNoResult() {
  async function* gen() {
    yield {
      type: "assistant" as const,
      uuid: "test-uuid",
      session_id: "test-session",
      message: {},
      parent_tool_use_id: null,
    };
  }
  return gen();
}

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
      mockedQuery.mockReturnValue(mockQuerySuccess("  Claude says hello  "));

      const result = await invokeClaude("Hello Claude", {
        anthropicKey: "sk-ant-test-key",
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("Claude says hello");
    });

    it("accepts optional configuration (timeout, allowEdits, octokit, context)", async () => {
      mockedQuery.mockReturnValue(mockQuerySuccess("output"));
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

  describe("invokes Claude SDK with the prompt", () => {
    it("uses read-only tools by default", async () => {
      mockedQuery.mockReturnValue(mockQuerySuccess("output"));

      await invokeClaude("Review this code", {
        anthropicKey: "sk-ant-test",
      });

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Review this code",
          options: expect.objectContaining({
            tools: ["Read", "Glob", "Grep"],
          }),
        }),
      );
    });

    it("uses edit tools when allowEdits is true", async () => {
      mockedQuery.mockReturnValue(mockQuerySuccess("output"));

      await invokeClaude("Fix this bug", {
        anthropicKey: "sk-ant-test",
        allowEdits: true,
      });

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          }),
        }),
      );
    });
  });

  describe("captures and returns output", () => {
    it("returns trimmed output in ClaudeResult", async () => {
      mockedQuery.mockReturnValue(mockQuerySuccess('\n  { "type": "bug" }  \n'));

      const result = await invokeClaude("triage", {
        anthropicKey: "sk-ant-test",
      });

      expect(result.output).toBe('{ "type": "bug" }');
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("handles timeouts", () => {
    it("returns specific timeout error message when aborted", async () => {
      mockedQuery.mockReturnValue((async function* () {
        const error = new Error("Aborted");
        error.name = "AbortError";
        throw error;
        yield; // unreachable, satisfies require-yield
      })());

      const result = await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
        timeoutMinutes: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Claude Code timed out after 10 minutes");
    });
  });

  describe("handles errors and surfaces them as comments", () => {
    it("returns error result on SDK error", async () => {
      mockedQuery.mockReturnValue(mockQueryError(["CLI not found"]));

      const result = await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("CLI not found");
      expect(result.output).toBe("");
    });

    it("returns error result when no result message received", async () => {
      mockedQuery.mockReturnValue(mockQueryNoResult());

      const result = await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("No result received from Claude Agent SDK");
      expect(result.output).toBe("");
    });

    it("posts error comment on issue when octokit and context provided", async () => {
      mockedQuery.mockReturnValue(mockQueryError(["API rate limited"]));

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
      mockedQuery.mockReturnValue(mockQueryError(["Network error"]));

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
      mockedQuery.mockReturnValue(mockQueryError(["fail"]));

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
      mockedQuery.mockReturnValue(mockQueryError(["fail"]));

      const result = await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
      });

      expect(result.success).toBe(false);
      // No crash, no comment posted
    });

    it("skips posting comment when context has no issue or PR", async () => {
      mockedQuery.mockReturnValue(mockQueryError(["fail"]));

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
      mockedQuery.mockReturnValue(mockQueryError(["something broke"]));

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
      mockedQuery.mockReturnValue(mockQuerySuccess("output"));

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-secret-key-12345",
      });

      const callArgs = mockedQuery.mock.calls[0][0];

      // API key must NOT appear in the prompt
      expect(callArgs.prompt).not.toContain("sk-ant-secret-key-12345");
      // API key must be in env
      expect(callArgs.options.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret-key-12345");
    });

    it("redacts API key from error comments", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-leaked-key";
      mockedQuery.mockReturnValue(
        mockQueryError(["Error: invalid key sk-ant-leaked-key at endpoint"]),
      );

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

  describe("uses bypassPermissions mode", () => {
    it("sets permissionMode and allowDangerouslySkipPermissions", async () => {
      mockedQuery.mockReturnValue(mockQuerySuccess("output"));

      await invokeClaude("prompt", {
        anthropicKey: "sk-ant-test",
      });

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
          }),
        }),
      );
    });
  });
});

// ── runClaude (convenience wrapper) ────────────

describe("runClaude", () => {
  it("returns trimmed output", async () => {
    mockedQuery.mockReturnValue(mockQuerySuccess("  result  "));
    const result = await runClaude("prompt", { anthropicKey: "sk-ant-test" });
    expect(result).toBe("result");
  });

  it("uses read-only tools", async () => {
    mockedQuery.mockReturnValue(mockQuerySuccess("ok"));
    await runClaude("test prompt", { anthropicKey: "sk-ant-test" });
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "test prompt",
        options: expect.objectContaining({
          tools: ["Read", "Glob", "Grep"],
        }),
      }),
    );
  });

  it("throws on SDK failure", async () => {
    mockedQuery.mockReturnValue(mockQueryError(["SDK error"]));
    await expect(
      runClaude("prompt", { anthropicKey: "sk-ant-test" }),
    ).rejects.toThrow("SDK error");
    expect(core.error).toHaveBeenCalled();
  });

  it("passes API key via env", async () => {
    mockedQuery.mockReturnValue(mockQuerySuccess("ok"));
    await runClaude("prompt", { anthropicKey: "sk-ant-key" });
    const options = mockedQuery.mock.calls[0][0].options;
    expect(options.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
  });
});

// ── runClaudeEdit (convenience wrapper) ────────

describe("runClaudeEdit", () => {
  it("returns trimmed output", async () => {
    mockedQuery.mockReturnValue(mockQuerySuccess("  result  "));
    const result = await runClaudeEdit("prompt", { anthropicKey: "sk-ant-test" });
    expect(result).toBe("result");
  });

  it("uses edit tools", async () => {
    mockedQuery.mockReturnValue(mockQuerySuccess("ok"));
    await runClaudeEdit("edit prompt", { anthropicKey: "sk-ant-test" });
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        }),
      }),
    );
  });

  it("throws on SDK failure", async () => {
    mockedQuery.mockReturnValue(mockQueryError(["edit error"]));
    await expect(
      runClaudeEdit("prompt", { anthropicKey: "sk-ant-test" }),
    ).rejects.toThrow("edit error");
    expect(core.error).toHaveBeenCalled();
  });

  it("passes API key via env", async () => {
    mockedQuery.mockReturnValue(mockQuerySuccess("ok"));
    await runClaudeEdit("prompt", { anthropicKey: "sk-ant-key" });
    const options = mockedQuery.mock.calls[0][0].options;
    expect(options.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
  });
});
