/* eslint-disable @typescript-eslint/no-require-imports */
import * as core from "@actions/core";
import * as github from "@actions/github";

jest.mock("@actions/core");
jest.mock("@actions/github");
jest.mock("./blocked");
jest.mock("./config");
jest.mock("./guards");
jest.mock("./labels");
jest.mock("./router");
jest.mock("./stages/triage", () => jest.fn());
jest.mock("./stages/retriage", () => jest.fn());
jest.mock("./stages/specify", () => jest.fn());
jest.mock("./stages/approve-spec", () => jest.fn());
jest.mock("./stages/implement", () => jest.fn());
jest.mock("./stages/review", () => jest.fn());
jest.mock("./stages/fix", () => jest.fn());
jest.mock("./stages/ship", () => jest.fn());

import { checkBlocked } from "./blocked";
import { loadConfig } from "./config";
import { isBotActor, postStageError } from "./guards";
import { ensureLabels } from "./labels";
import { detectStage } from "./router";
import triage from "./stages/triage";

const mockedCore = core as jest.Mocked<typeof core>;
const mockedGetInput = core.getInput as jest.Mock;
const mockedSetOutput = core.setOutput as jest.Mock;
const mockedSetFailed = core.setFailed as jest.Mock;
const mockedLoadConfig = loadConfig as jest.Mock;
const mockedIsBotActor = isBotActor as jest.Mock;
const mockedCheckBlocked = checkBlocked as unknown as jest.Mock;
const mockedEnsureLabels = ensureLabels as unknown as jest.Mock;
const mockedDetectStage = detectStage as jest.Mock;
const mockedPostStageError = postStageError as jest.Mock;
const mockedTriage = triage as unknown as jest.Mock;

const fakeOctokit = {} as ReturnType<typeof github.getOctokit>;
const fakeContext = {
  payload: {
    issue: { number: 1 },
    sender: { login: "user", type: "User" },
  },
  repo: { owner: "test-owner", repo: "test-repo" },
} as unknown as typeof github.context;

beforeEach(() => {
  jest.clearAllMocks();

  mockedGetInput.mockImplementation((name: string) => {
    const inputs: Record<string, string> = {
      github_token: "ghp_test",
      anthropic_api_key: "sk-test",
      config_path: ".kiln/config.yml",
      stage: "auto",
      timeout_minutes: "30",
    };
    return inputs[name] || "";
  });

  (github.getOctokit as jest.Mock).mockReturnValue(fakeOctokit);
  Object.defineProperty(github, "context", {
    value: fakeContext,
    writable: true,
    configurable: true,
  });

  mockedLoadConfig.mockResolvedValue({ labels: { prefix: "kiln" } });
  mockedEnsureLabels.mockResolvedValue(undefined);
  mockedIsBotActor.mockReturnValue(false);
  mockedCheckBlocked.mockResolvedValue(false);
  mockedPostStageError.mockResolvedValue(undefined);
});

// Use the exported run function directly
const { run } = require("./index") as { run: () => Promise<void> };

describe("US-015: Error Handling & Observability", () => {
  // ── AC1: All stages wrap execution in try/catch and post error details ──
  describe("AC1: try/catch with error comments", () => {
    it("posts error comment when stage throws an error", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockRejectedValue(new Error("Something broke"));

      await run();

      expect(mockedPostStageError).toHaveBeenCalledWith(
        fakeOctokit,
        fakeContext,
        "triage",
        "Something broke",
      );
    });

    it("posts error comment when stage returns error status", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockResolvedValue({
        status: "error",
        reason: "Spec not found",
      });

      await run();

      expect(mockedPostStageError).toHaveBeenCalledWith(
        fakeOctokit,
        fakeContext,
        "triage",
        "Spec not found",
      );
    });

    it("uses 'unknown error' when error status has no reason", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockResolvedValue({ status: "error" });

      await run();

      expect(mockedPostStageError).toHaveBeenCalledWith(
        fakeOctokit,
        fakeContext,
        "triage",
        "unknown error",
      );
    });

    it("does not post error comment for successful stages", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockResolvedValue({ status: "success" });

      await run();

      expect(mockedPostStageError).not.toHaveBeenCalled();
    });
  });

  // ── AC2: Error comments are branded ──
  describe("AC2: branded error comments", () => {
    it("calls core.error with Kiln branding on thrown errors", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockRejectedValue(new Error("Test failure"));

      await run();

      expect(mockedCore.error).toHaveBeenCalledWith(
        expect.stringContaining("🔥 Kiln"),
      );
    });

    it("calls core.error with Kiln branding on returned errors", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockResolvedValue({ status: "error", reason: "Test" });

      await run();

      expect(mockedCore.error).toHaveBeenCalledWith(
        expect.stringContaining("🔥 Kiln"),
      );
    });
  });

  // ── AC3: Step outputs include stage name, duration, and result ──
  describe("AC3: step outputs", () => {
    it("sets stage output on success", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockResolvedValue({ status: "success" });

      await run();

      expect(mockedSetOutput).toHaveBeenCalledWith("stage", "triage");
    });

    it("sets result output on success", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockResolvedValue({ status: "success" });

      await run();

      expect(mockedSetOutput).toHaveBeenCalledWith("result", "success");
    });

    it("sets duration output on success", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockResolvedValue({ status: "success" });

      await run();

      expect(mockedSetOutput).toHaveBeenCalledWith(
        "duration",
        expect.any(String),
      );
      // Duration should be a numeric string
      const durationCall = mockedSetOutput.mock.calls.find(
        (c: string[]) => c[0] === "duration",
      );
      expect(Number(durationCall![1])).toBeGreaterThanOrEqual(0);
    });

    it("sets duration output on error", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockRejectedValue(new Error("Failed"));

      await run();

      expect(mockedSetOutput).toHaveBeenCalledWith(
        "duration",
        expect.any(String),
      );
    });

    it("sets stage output on error", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockRejectedValue(new Error("Failed"));

      await run();

      expect(mockedSetOutput).toHaveBeenCalledWith("stage", "triage");
    });

    it("sets result to error on thrown error", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockRejectedValue(new Error("Failed"));

      await run();

      expect(mockedSetOutput).toHaveBeenCalledWith("result", "error");
    });

    it("includes pr_number output when stage returns one", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockResolvedValue({ status: "success", prNumber: 42 });

      await run();

      expect(mockedSetOutput).toHaveBeenCalledWith("pr_number", "42");
    });

    it("logs completion with duration", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockResolvedValue({ status: "success" });

      await run();

      expect(mockedCore.info).toHaveBeenCalledWith(
        expect.stringMatching(/completed in \d+s/),
      );
    });
  });

  // ── AC4: Failed stages do not advance the pipeline ──
  describe("AC4: no pipeline advancement on error", () => {
    it("calls setFailed when stage throws", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockRejectedValue(new Error("Crash"));

      await run();

      expect(mockedSetFailed).toHaveBeenCalledWith(
        expect.stringContaining("Crash"),
      );
    });

    it("returns immediately after stage throw (no completion log)", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockRejectedValue(new Error("Crash"));

      await run();

      // Should not log completion message after error
      expect(mockedCore.info).not.toHaveBeenCalledWith(
        expect.stringContaining("completed"),
      );
    });
  });

  // ── AC5: Timeout errors produce specific message ──
  describe("AC5: timeout-specific error messages", () => {
    it("detects killed process as timeout error", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      const timeoutError = new Error("Command failed") as Error & {
        killed: boolean;
      };
      timeoutError.killed = true;
      mockedTriage.mockRejectedValue(timeoutError);

      await run();

      expect(mockedPostStageError).toHaveBeenCalledWith(
        fakeOctokit,
        fakeContext,
        "triage",
        expect.stringContaining("timed out"),
      );
    });

    it("timeout message includes duration in seconds", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      const timeoutError = new Error("Command failed") as Error & {
        killed: boolean;
      };
      timeoutError.killed = true;
      mockedTriage.mockRejectedValue(timeoutError);

      await run();

      expect(mockedPostStageError).toHaveBeenCalledWith(
        fakeOctokit,
        fakeContext,
        "triage",
        expect.stringMatching(/timed out after \d+s/),
      );
    });

    it("non-timeout errors use original error message", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockRejectedValue(new Error("API rate limit exceeded"));

      await run();

      expect(mockedPostStageError).toHaveBeenCalledWith(
        fakeOctokit,
        fakeContext,
        "triage",
        "API rate limit exceeded",
      );
    });

    it("handles string errors gracefully", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      mockedTriage.mockRejectedValue("unexpected string error");

      await run();

      expect(mockedPostStageError).toHaveBeenCalledWith(
        fakeOctokit,
        fakeContext,
        "triage",
        "unexpected string error",
      );
    });

    it("setFailed includes timeout message", async () => {
      mockedDetectStage.mockReturnValue({ stage: "triage" });
      const timeoutError = new Error("Command failed") as Error & {
        killed: boolean;
      };
      timeoutError.killed = true;
      mockedTriage.mockRejectedValue(timeoutError);

      await run();

      expect(mockedSetFailed).toHaveBeenCalledWith(
        expect.stringContaining("timed out"),
      );
    });
  });
});
