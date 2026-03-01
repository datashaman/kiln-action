import { isBotActor, postStageError } from "./guards";
import { Octokit } from "./types";
import { Context } from "@actions/github/lib/context";

jest.mock("@actions/core");

function makeOctokit(): Octokit {
  return {
    rest: {
      issues: {
        createComment: jest.fn().mockResolvedValue({}),
      },
    },
  } as unknown as Octokit;
}

function makeContext(sender?: { login?: string; type?: string }): Context {
  return {
    payload: {
      sender,
      issue: { number: 5 },
    },
    repo: { owner: "test-owner", repo: "test-repo" },
  } as unknown as Context;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("isBotActor", () => {
  it("returns true for github-actions[bot] login", () => {
    const ctx = makeContext({
      login: "github-actions[bot]",
      type: "Bot",
    });
    expect(isBotActor(ctx)).toBe(true);
  });

  it("returns true for kiln[bot] login", () => {
    const ctx = makeContext({
      login: "kiln[bot]",
      type: "Bot",
    });
    expect(isBotActor(ctx)).toBe(true);
  });

  it("returns true for any Bot type sender", () => {
    const ctx = makeContext({
      login: "some-other-bot[bot]",
      type: "Bot",
    });
    expect(isBotActor(ctx)).toBe(true);
  });

  it("returns false for human User type sender", () => {
    const ctx = makeContext({
      login: "octocat",
      type: "User",
    });
    expect(isBotActor(ctx)).toBe(false);
  });

  it("returns false when sender is undefined", () => {
    const ctx = makeContext(undefined);
    expect(isBotActor(ctx)).toBe(false);
  });

  it("returns false when sender has no type and non-bot login", () => {
    const ctx = makeContext({
      login: "developer",
    });
    expect(isBotActor(ctx)).toBe(false);
  });

  it("returns true when sender type is Bot even with human-like login", () => {
    const ctx = makeContext({
      login: "john",
      type: "Bot",
    });
    expect(isBotActor(ctx)).toBe(true);
  });
});

describe("postStageError", () => {
  it("posts branded error comment on issue", async () => {
    const octokit = makeOctokit();
    const context = makeContext({ login: "test", type: "User" });

    await postStageError(octokit, context, "triage", "Something went wrong");

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 5,
        body: "🔥 **Kiln** — Error in triage: Something went wrong",
      }),
    );
  });

  it("includes stage name in error comment", async () => {
    const octokit = makeOctokit();
    const context = makeContext({ login: "test", type: "User" });

    await postStageError(octokit, context, "implement", "Timeout");

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("implement"),
      }),
    );
  });

  it("posts on PR number when no issue", async () => {
    const octokit = makeOctokit();
    const context = {
      payload: {
        pull_request: { number: 42 },
      },
      repo: { owner: "test-owner", repo: "test-repo" },
    } as unknown as Context;

    await postStageError(octokit, context, "review", "Failed");

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
      }),
    );
  });

  it("does nothing when no issue or PR number", async () => {
    const octokit = makeOctokit();
    const context = {
      payload: {},
      repo: { owner: "test-owner", repo: "test-repo" },
    } as unknown as Context;

    await postStageError(octokit, context, "triage", "Error");

    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("does not throw when comment posting fails", async () => {
    const octokit = makeOctokit();
    (octokit.rest.issues.createComment as unknown as jest.Mock).mockRejectedValue(
      new Error("API error"),
    );
    const context = makeContext({ login: "test", type: "User" });

    await expect(
      postStageError(octokit, context, "triage", "Error"),
    ).resolves.not.toThrow();
  });

  it("error comment is Kiln-branded", async () => {
    const octokit = makeOctokit();
    const context = makeContext({ login: "test", type: "User" });

    await postStageError(octokit, context, "specify", "Test error");

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("**Kiln**"),
      }),
    );
  });
});
