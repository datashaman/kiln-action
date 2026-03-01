import retriage from "./retriage";
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
        listComments: jest.fn().mockResolvedValue({
          data: [
            {
              user: { login: "author-user" },
              body: "Here is the additional info you requested.",
            },
          ],
        }),
      },
    },
  } as unknown as Octokit;
}

function makeConfig(prefix = "kiln"): KilnConfig {
  return { labels: { prefix } } as unknown as KilnConfig;
}

function makeContext(
  overrides: {
    issuePayload?: Record<string, unknown>;
    commentPayload?: Record<string, unknown>;
  } = {},
): Context {
  return {
    eventName: "issue_comment",
    payload: {
      action: "created",
      issue: overrides.issuePayload || {
        number: 42,
        title: "Add dark mode",
        body: "I want dark mode support.",
        labels: [{ name: "kiln:needs-info" }],
      },
      comment: overrides.commentPayload || {
        user: { login: "author-user", type: "User" },
        body: "Here is the additional info you requested.",
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

const CLEAR_RESPONSE = JSON.stringify({
  type: "feature",
  complexity: "m",
  clear_enough: true,
  comment:
    "Thanks for the clarification! I now understand you want dark mode for all pages. Moving to specification.",
  labels: [],
});

const UNCLEAR_RESPONSE = JSON.stringify({
  type: "feature",
  complexity: "l",
  clear_enough: false,
  comment:
    "Thanks for the update, but I still need to know: should dark mode persist across sessions?",
  labels: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedTransitionLabel.mockResolvedValue(undefined);
});

describe("retriage", () => {
  // ── AC: Triggers on issue_comment.created ───────────
  describe("triggers on issue_comment.created", () => {
    it("processes a comment event", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      const result = await retriage(ctx);
      expect(result.status).toBe("success");
    });

    it("logs the issue number and title", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      await retriage(ctx);
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Issue #42: Add dark mode"),
      );
    });
  });

  // ── AC: Only runs if issue has kiln:intake or kiln:needs-info ──
  // (This is handled by the router, but we verify the handler runs correctly)
  describe("handles issues with intake/needs-info labels", () => {
    it("runs for issue with kiln:needs-info label", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      const result = await retriage(ctx);
      expect(result.status).toBe("success");
      expect(mockedRunClaude).toHaveBeenCalled();
    });

    it("runs for issue with kiln:intake label", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx({
        context: makeContext({
          issuePayload: {
            number: 42,
            title: "Add dark mode",
            body: "I want dark mode support.",
            labels: [{ name: "kiln:intake" }],
          },
        }),
      });
      const result = await retriage(ctx);
      expect(result.status).toBe("success");
      expect(mockedRunClaude).toHaveBeenCalled();
    });
  });

  // ── AC: Ignores comments from bots/actions ──────────
  describe("ignores bot comments", () => {
    it("ignores comments from Bot user type", async () => {
      const ctx = makeCtx({
        context: makeContext({
          commentPayload: {
            user: { login: "some-bot", type: "Bot" },
            body: "Automated message",
          },
        }),
      });
      const result = await retriage(ctx);

      expect(result.status).toBe("success");
      expect(result.nextStage).toBe("waiting-for-info");
      expect(mockedRunClaude).not.toHaveBeenCalled();
    });

    it("ignores comments from github-actions[bot]", async () => {
      const ctx = makeCtx({
        context: makeContext({
          commentPayload: {
            user: { login: "github-actions[bot]", type: "Bot" },
            body: "Kiln triage comment",
          },
        }),
      });
      const result = await retriage(ctx);

      expect(result.status).toBe("success");
      expect(result.nextStage).toBe("waiting-for-info");
      expect(mockedRunClaude).not.toHaveBeenCalled();
    });

    it("logs when ignoring bot comment", async () => {
      const ctx = makeCtx({
        context: makeContext({
          commentPayload: {
            user: { login: "some-bot", type: "Bot" },
            body: "Automated message",
          },
        }),
      });
      await retriage(ctx);

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring bot comment from some-bot"),
      );
    });

    it("processes comments from regular users", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx({
        context: makeContext({
          commentPayload: {
            user: { login: "human-user", type: "User" },
            body: "Here is the info",
          },
        }),
      });
      const result = await retriage(ctx);

      expect(result.status).toBe("success");
      expect(mockedRunClaude).toHaveBeenCalled();
    });
  });

  // ── AC: Sends full issue body + all comments to Claude ────
  describe("sends full context to Claude", () => {
    it("includes issue title, body, and comments in the prompt", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      await retriage(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Add dark mode");
      expect(prompt).toContain("I want dark mode support.");
      expect(prompt).toContain("@author-user");
      expect(prompt).toContain(
        "Here is the additional info you requested.",
      );
    });

    it("fetches comments from the GitHub API", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      await retriage(ctx);

      expect(ctx.octokit.rest.issues.listComments).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          issue_number: 42,
          per_page: 100,
        }),
      );
    });

    it("includes multiple comments in the prompt", async () => {
      const octokit = makeOctokit();
      (octokit.rest.issues.listComments as unknown as jest.Mock).mockResolvedValue({
        data: [
          { user: { login: "author" }, body: "First comment" },
          { user: { login: "maintainer" }, body: "What framework?" },
          { user: { login: "author" }, body: "Using React" },
        ],
      });
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx({ octokit });
      await retriage(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("@author");
      expect(prompt).toContain("First comment");
      expect(prompt).toContain("@maintainer");
      expect(prompt).toContain("What framework?");
      expect(prompt).toContain("Using React");
    });

    it("handles empty issue body", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx({
        context: makeContext({
          issuePayload: {
            number: 42,
            title: "Add dark mode",
            body: null,
            labels: [{ name: "kiln:needs-info" }],
          },
        }),
      });
      await retriage(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("(empty)");
    });

    it("passes anthropic key and timeout to runClaude", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx({
        anthropicKey: "sk-ant-custom",
        timeoutMinutes: 15,
      });
      await retriage(ctx);

      expect(mockedRunClaude).toHaveBeenCalledWith(expect.any(String), {
        anthropicKey: "sk-ant-custom",
        timeoutMinutes: 15,
      });
    });

    it("mentions re-triage context in the prompt", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      await retriage(ctx);

      const prompt = mockedRunClaude.mock.calls[0][0] as string;
      expect(prompt).toMatch(/re-?triage/i);
    });
  });

  // ── AC: If now clear → remove needs-info, apply specifying ──
  describe("clear_enough is true", () => {
    it("transitions from needs-info to specifying", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      await retriage(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        ctx.octokit,
        ctx.context,
        42,
        "needs-info",
        "specifying",
        "kiln",
      );
    });

    it("returns nextStage: specify", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      const result = await retriage(ctx);

      expect(result.nextStage).toBe("specify");
    });

    it("posts confirmation comment", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      await retriage(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42,
          body: expect.stringContaining(
            "Thanks for the clarification",
          ),
        }),
      );
    });

    it("uses custom label prefix", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx({ config: makeConfig("myapp") });
      await retriage(ctx);

      expect(mockedTransitionLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        42,
        "needs-info",
        "specifying",
        "myapp",
      );
    });
  });

  // ── AC: If still unclear → keep needs-info, post follow-up ──
  describe("clear_enough is false", () => {
    it("does NOT transition labels", async () => {
      mockedRunClaude.mockReturnValue(UNCLEAR_RESPONSE);
      const ctx = makeCtx();
      await retriage(ctx);

      expect(mockedTransitionLabel).not.toHaveBeenCalled();
    });

    it("returns nextStage: waiting-for-info", async () => {
      mockedRunClaude.mockReturnValue(UNCLEAR_RESPONSE);
      const ctx = makeCtx();
      const result = await retriage(ctx);

      expect(result.nextStage).toBe("waiting-for-info");
    });

    it("posts follow-up clarification request", async () => {
      mockedRunClaude.mockReturnValue(UNCLEAR_RESPONSE);
      const ctx = makeCtx();
      await retriage(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42,
          body: expect.stringContaining(
            "should dark mode persist across sessions",
          ),
        }),
      );
    });

    it("keeps kiln:needs-info label (no label changes)", async () => {
      mockedRunClaude.mockReturnValue(UNCLEAR_RESPONSE);
      const ctx = makeCtx();
      await retriage(ctx);

      // No label transitions should happen
      expect(mockedTransitionLabel).not.toHaveBeenCalled();
      // No addLabels calls for needs-info (it's already there)
      expect(ctx.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });
  });

  // ── AC: Posts Kiln-branded comment ────────────────────
  describe("branded comment", () => {
    it("posts a Kiln-branded re-triage comment", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      await retriage(ctx);

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringMatching(/^🔥 \*\*Kiln Re-triage\*\*/),
        }),
      );
    });
  });

  // ── JSON parsing ───────────────────────────────────────
  describe("parses Claude JSON response", () => {
    it("parses JSON from code block", async () => {
      mockedRunClaude.mockReturnValue(
        '```json\n{"type":"bug","complexity":"s","clear_enough":true,"comment":"Got it.","labels":[]}\n```',
      );
      const ctx = makeCtx();
      const result = await retriage(ctx);
      expect(result.status).toBe("success");
      expect(result.nextStage).toBe("specify");
    });

    it("parses raw JSON without code block", async () => {
      mockedRunClaude.mockReturnValue(CLEAR_RESPONSE);
      const ctx = makeCtx();
      const result = await retriage(ctx);
      expect(result.status).toBe("success");
    });

    it("falls back to defaults on parse failure", async () => {
      mockedRunClaude.mockReturnValue("This is not JSON at all");
      const ctx = makeCtx();
      const result = await retriage(ctx);

      expect(result.status).toBe("success");
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse re-triage response"),
      );
      // Default: clear_enough=true → moves to specify
      expect(result.nextStage).toBe("specify");
    });

    it("logs raw output on parse failure", async () => {
      mockedRunClaude.mockReturnValue("garbage output");
      const ctx = makeCtx();
      await retriage(ctx);

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Raw output: garbage output"),
      );
    });
  });
});
