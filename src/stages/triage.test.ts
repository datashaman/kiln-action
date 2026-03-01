import triage from "./triage";
import { KilnContext, KilnConfig, Octokit } from "../types";
import { Context } from "@actions/github/lib/context";

jest.mock("@actions/core");
jest.mock("../claude");
jest.mock("../labels");

import * as core from "@actions/core";
import { runClaude } from "../claude";
import { transitionLabel } from "../labels";

const mockedRunClaude = runClaude as unknown as jest.Mock;
const mockedTransitionLabel = transitionLabel as unknown as jest.Mock;

function makeOctokit(): Octokit {
  return {
    rest: {
      issues: {
        createComment: jest.fn().mockResolvedValue({}),
        addLabels: jest.fn().mockResolvedValue({}),
      },
    },
  } as unknown as Octokit;
}

function makeConfig(prefix = "kiln"): KilnConfig {
  return { labels: { prefix } } as unknown as KilnConfig;
}

function makeContext(issuePayload: Record<string, unknown>): Context {
  return {
    eventName: "issues",
    payload: {
      action: "opened",
      issue: issuePayload,
    },
    repo: { owner: "test-owner", repo: "test-repo" },
  } as unknown as Context;
}

function makeCtx(overrides: Partial<KilnContext> = {}): KilnContext {
  return {
    octokit: makeOctokit(),
    context: makeContext({
      number: 1,
      title: "Add dark mode",
      body: "I want dark mode support for the app.",
      labels: [],
    }),
    config: makeConfig(),
    anthropicKey: "sk-ant-test-key",
    timeoutMinutes: 30,
    token: "ghp-test-token",
    ...overrides,
  };
}

const VALID_RESPONSE = JSON.stringify({
  type: "feature",
  complexity: "m",
  clear_enough: true,
  comment: "I understand you want dark mode support. Moving to specification.",
  labels: ["ui", "theme"],
});

const UNCLEAR_RESPONSE = JSON.stringify({
  type: "feature",
  complexity: "l",
  clear_enough: false,
  comment:
    "Could you clarify which pages should support dark mode? Also, should it persist across sessions?",
  labels: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedTransitionLabel.mockResolvedValue(undefined);
});

describe("triage", () => {
  // ── AC: Triggers on issues.opened ─────────────────────
  describe("triggers on issues.opened", () => {
    it("processes an opened issue", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      const result = await triage(ctx);
      expect(result.status).toBe("success");
    });

    it("logs the issue number and title", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Issue #1: Add dark mode"),
      );
    });
  });

  // ── AC: Sends issue title and body to Claude ──────────
  describe("sends issue context to Claude", () => {
    it("passes issue title and body in the prompt", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Add dark mode");
      expect(prompt).toContain("I want dark mode support for the app.");
    });

    it("passes issue number in the prompt", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Issue #1");
    });

    it("handles empty issue body", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx({
        context: makeContext({
          number: 2,
          title: "Bug",
          body: null,
          labels: [],
        }),
      });
      await triage(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("(empty)");
    });

    it("passes anthropic key and timeout to runClaude", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx({ anthropicKey: "sk-ant-custom", timeoutMinutes: 15 });
      await triage(ctx);

      expect(mockedRunClaude).toHaveBeenCalledWith(expect.any(String), {
        anthropicKey: "sk-ant-custom",
        timeoutMinutes: 15,
      });
    });
  });

  // ── AC: Claude responds with structured JSON ──────────
  describe("parses Claude JSON response", () => {
    it("parses JSON from code block", async () => {
      mockedRunClaude.mockReturnValue(
        '```json\n{"type":"bug","complexity":"s","clear_enough":true,"comment":"Got it.","labels":[]}\n```',
      );
      const ctx = makeCtx();
      const result = await triage(ctx);
      expect(result.status).toBe("success");
    });

    it("parses raw JSON without code block", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      const result = await triage(ctx);
      expect(result.status).toBe("success");
    });

    it("falls back to defaults on parse failure", async () => {
      mockedRunClaude.mockReturnValue("This is not JSON at all");
      const ctx = makeCtx();
      const result = await triage(ctx);

      expect(result.status).toBe("success");
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse triage response"),
      );
      // Default: clear_enough=true → moves to specify
      expect(result.nextStage).toBe("specify");
    });

    it("logs raw output on parse failure", async () => {
      mockedRunClaude.mockReturnValue("garbage output");
      const ctx = makeCtx();
      await triage(ctx);

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Raw output: garbage output"),
      );
    });
  });

  // ── AC: Applies type and size labels ──────────────────
  describe("applies labels", () => {
    it("applies type:{type} and size:{complexity} labels", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          issue_number: 1,
          labels: expect.arrayContaining(["type:feature", "size:m"]),
        }),
      );
    });

    it("applies additional labels from Claude response", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.arrayContaining(["ui", "theme"]),
        }),
      );
    });

    it("handles missing labels array in response", async () => {
      mockedRunClaude.mockReturnValue(
        JSON.stringify({
          type: "bug",
          complexity: "xs",
          clear_enough: true,
          comment: "Got it.",
        }),
      );
      const ctx = makeCtx();
      const result = await triage(ctx);

      expect(result.status).toBe("success");
      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: ["type:bug", "size:xs"],
        }),
      );
    });
  });

  // ── AC: clear_enough=true → specifying ────────────────
  describe("clear_enough is true", () => {
    it("applies kiln:specifying label", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        ctx.octokit,
        ctx.context,
        1,
        null,
        "specifying",
        "kiln",
      );
    });

    it("returns nextStage: specify", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      const result = await triage(ctx);

      expect(result.nextStage).toBe("specify");
    });

    it("posts confirmation comment", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 1,
          body: expect.stringContaining(
            "I understand you want dark mode support",
          ),
        }),
      );
    });
  });

  // ── AC: clear_enough=false → needs-info ───────────────
  describe("clear_enough is false", () => {
    it("applies kiln:needs-info label with proper prefix", async () => {
      mockedRunClaude.mockReturnValue(UNCLEAR_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 1,
          labels: ["kiln:needs-info"],
        }),
      );
    });

    it("uses custom prefix for needs-info label", async () => {
      mockedRunClaude.mockReturnValue(UNCLEAR_RESPONSE);
      const ctx = makeCtx({ config: makeConfig("myapp") });
      await triage(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: ["myapp:needs-info"],
        }),
      );
    });

    it("posts clarification comment from Claude", async () => {
      mockedRunClaude.mockReturnValue(UNCLEAR_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            "Could you clarify which pages should support dark mode",
          ),
        }),
      );
    });

    it("does NOT apply kiln:specifying label", async () => {
      mockedRunClaude.mockReturnValue(UNCLEAR_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      expect(mockedTransitionLabel).not.toHaveBeenCalled();
    });

    it("returns nextStage: waiting-for-info", async () => {
      mockedRunClaude.mockReturnValue(UNCLEAR_RESPONSE);
      const ctx = makeCtx();
      const result = await triage(ctx);

      expect(result.nextStage).toBe("waiting-for-info");
    });
  });

  // ── AC: Posts Kiln-branded comment ────────────────────
  describe("branded comment", () => {
    it("posts a Kiln-branded triage comment", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringMatching(/^🔥 \*\*Kiln Triage\*\*/),
        }),
      );
    });

    it("includes type and complexity in the comment", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx();
      await triage(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("`feature`"),
        }),
      );

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("`m`"),
        }),
      );
    });
  });

  // ── Edge cases ────────────────────────────────────────
  describe("edge cases", () => {
    it("handles bug type correctly", async () => {
      mockedRunClaude.mockReturnValue(
        JSON.stringify({
          type: "bug",
          complexity: "xs",
          clear_enough: true,
          comment: "Confirmed bug.",
          labels: [],
        }),
      );
      const ctx = makeCtx();
      await triage(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.arrayContaining(["type:bug", "size:xs"]),
        }),
      );
    });

    it("handles improvement type correctly", async () => {
      mockedRunClaude.mockReturnValue(
        JSON.stringify({
          type: "improvement",
          complexity: "l",
          clear_enough: true,
          comment: "Good improvement idea.",
          labels: [],
        }),
      );
      const ctx = makeCtx();
      await triage(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.arrayContaining(["type:improvement", "size:l"]),
        }),
      );
    });

    it("handles chore type correctly", async () => {
      mockedRunClaude.mockReturnValue(
        JSON.stringify({
          type: "chore",
          complexity: "xl",
          clear_enough: false,
          comment: "Need more details.",
          labels: [],
        }),
      );
      const ctx = makeCtx();
      await triage(ctx);

      expect(ctx.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.arrayContaining(["type:chore", "size:xl"]),
        }),
      );
    });

    it("uses custom label prefix for specifying", async () => {
      mockedRunClaude.mockReturnValue(VALID_RESPONSE);
      const ctx = makeCtx({ config: makeConfig("myapp") });
      await triage(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        1,
        null,
        "specifying",
        "myapp",
      );
    });
  });
});
