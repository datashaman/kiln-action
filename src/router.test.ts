import { detectStage } from "./router";
import { Context } from "@actions/github/lib/context";

// Mock @actions/core to capture log output
const mockInfo = jest.fn();
jest.mock("@actions/core", () => ({
  info: (...args: unknown[]) => mockInfo(...args),
}));

function makeContext(
  eventName: string,
  payload: Record<string, unknown>,
): Context {
  return { eventName, payload } as unknown as Context;
}

beforeEach(() => {
  mockInfo.mockClear();
});

describe("detectStage", () => {
  // ── issues.opened → triage ────────────────────────────
  describe("issues.opened → triage", () => {
    it("returns triage stage for new issue", () => {
      const ctx = makeContext("issues", {
        action: "opened",
        issue: { number: 42, labels: [] },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("triage");
      expect(result!.issueNumber).toBe(42);
      expect(result!.labels).toEqual([]);
    });
  });

  // ── issue_comment.created → re-triage ─────────────────
  describe("issue_comment.created → re-triage", () => {
    it("returns re-triage when issue has kiln:intake label", () => {
      const ctx = makeContext("issue_comment", {
        action: "created",
        issue: { number: 7, labels: [{ name: "kiln:intake" }] },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("re-triage");
      expect(result!.issueNumber).toBe(7);
      expect(result!.labels).toEqual(["kiln:intake"]);
    });

    it("returns re-triage when issue has kiln:needs-info label", () => {
      const ctx = makeContext("issue_comment", {
        action: "created",
        issue: { number: 8, labels: [{ name: "kiln:needs-info" }] },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("re-triage");
    });

    it("returns null when issue has no matching labels", () => {
      const ctx = makeContext("issue_comment", {
        action: "created",
        issue: { number: 9, labels: [{ name: "bug" }] },
      });
      const result = detectStage(ctx);
      expect(result).toBeNull();
    });
  });

  // ── issues.labeled (kiln:specifying) → specify ────────
  describe("issues.labeled → specify", () => {
    it("returns specify when kiln:specifying label is added", () => {
      const ctx = makeContext("issues", {
        action: "labeled",
        label: { name: "kiln:specifying" },
        issue: { number: 10, labels: [{ name: "kiln:specifying" }] },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("specify");
      expect(result!.issueNumber).toBe(10);
    });
  });

  // ── issues.labeled (kiln:implementing) → implement ────
  describe("issues.labeled → implement", () => {
    it("returns implement when kiln:implementing label is added", () => {
      const ctx = makeContext("issues", {
        action: "labeled",
        label: { name: "kiln:implementing" },
        issue: { number: 11, labels: [{ name: "kiln:implementing" }] },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("implement");
      expect(result!.issueNumber).toBe(11);
    });
  });

  // ── pull_request_review.submitted approved + spec PR → approve-spec
  describe("pull_request_review.submitted approved + spec → approve-spec", () => {
    it("returns approve-spec for approved review on spec PR", () => {
      const ctx = makeContext("pull_request_review", {
        action: "submitted",
        review: { state: "approved" },
        pull_request: {
          number: 20,
          labels: [{ name: "kiln:spec" }],
        },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("approve-spec");
      expect(result!.prNumber).toBe(20);
    });
  });

  // ── pull_request.opened + impl PR → review ────────────
  describe("pull_request.opened/synchronize + impl → review", () => {
    it("returns review for opened impl PR", () => {
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 30,
          labels: [{ name: "kiln:implementation" }],
        },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("review");
      expect(result!.prNumber).toBe(30);
    });

    it("returns review for synchronize on impl PR", () => {
      const ctx = makeContext("pull_request", {
        action: "synchronize",
        pull_request: {
          number: 31,
          labels: [{ name: "kiln:implementation" }],
        },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("review");
    });

    it("returns null for opened PR without implementation label", () => {
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 32,
          labels: [{ name: "kiln:spec" }],
        },
      });
      const result = detectStage(ctx);
      expect(result).toBeNull();
    });
  });

  // ── pull_request_review changes_requested + impl → fix
  describe("pull_request_review changes_requested + impl → fix", () => {
    it("returns fix for changes_requested on impl PR", () => {
      const ctx = makeContext("pull_request_review", {
        action: "submitted",
        review: { state: "changes_requested" },
        pull_request: {
          number: 40,
          labels: [{ name: "kiln:implementation" }],
        },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("fix");
      expect(result!.prNumber).toBe(40);
    });
  });

  // ── pull_request_review approved + impl → release ─────
  describe("pull_request_review approved + impl → release", () => {
    it("returns release for approved review on impl PR", () => {
      const ctx = makeContext("pull_request_review", {
        action: "submitted",
        review: { state: "approved" },
        pull_request: {
          number: 50,
          labels: [{ name: "kiln:implementation" }],
        },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("release");
      expect(result!.prNumber).toBe(50);
    });
  });

  // ── check_suite.completed → release ───────────────────
  describe("check_suite.completed → release", () => {
    it("returns release when check_suite has associated PRs", () => {
      const ctx = makeContext("check_suite", {
        action: "completed",
        check_suite: {
          pull_requests: [{ number: 60 }],
        },
      });
      const result = detectStage(ctx);
      expect(result).not.toBeNull();
      expect(result!.stage).toBe("release");
    });

    it("returns null when check_suite has no associated PRs", () => {
      const ctx = makeContext("check_suite", {
        action: "completed",
        check_suite: {
          pull_requests: [],
        },
      });
      const result = detectStage(ctx);
      expect(result).toBeNull();
    });
  });

  // ── Unmatched events → null (clean no-op) ─────────────
  describe("unmatched events → null", () => {
    it("returns null for push events", () => {
      const ctx = makeContext("push", { action: undefined });
      const result = detectStage(ctx);
      expect(result).toBeNull();
    });

    it("returns null for issues.closed", () => {
      const ctx = makeContext("issues", {
        action: "closed",
        issue: { number: 99, labels: [] },
      });
      const result = detectStage(ctx);
      expect(result).toBeNull();
    });

    it("returns null for issues.labeled with unrelated label", () => {
      const ctx = makeContext("issues", {
        action: "labeled",
        label: { name: "bug" },
        issue: { number: 100, labels: [{ name: "bug" }] },
      });
      const result = detectStage(ctx);
      expect(result).toBeNull();
    });
  });

  // ── Logging ───────────────────────────────────────────
  describe("logging", () => {
    it("logs the matched stage", () => {
      const ctx = makeContext("issues", {
        action: "opened",
        issue: { number: 1, labels: [] },
      });
      detectStage(ctx);
      expect(mockInfo).toHaveBeenCalledWith(
        expect.stringContaining("Matched stage: triage"),
      );
    });

    it("logs no matching stage for unmatched events", () => {
      const ctx = makeContext("push", { action: undefined });
      detectStage(ctx);
      expect(mockInfo).toHaveBeenCalledWith(
        expect.stringContaining("No matching stage"),
      );
    });
  });

  // ── Parsed context ────────────────────────────────────
  describe("parsed context", () => {
    it("includes issue number and labels for issue events", () => {
      const ctx = makeContext("issues", {
        action: "opened",
        issue: {
          number: 5,
          labels: [{ name: "bug" }, { name: "priority:high" }],
        },
      });
      const result = detectStage(ctx);
      expect(result!.issueNumber).toBe(5);
      expect(result!.labels).toEqual(["bug", "priority:high"]);
      expect(result!.payload).toBeDefined();
    });

    it("includes PR number and labels for PR events", () => {
      const ctx = makeContext("pull_request", {
        action: "opened",
        pull_request: {
          number: 15,
          labels: [{ name: "kiln:implementation" }],
        },
      });
      const result = detectStage(ctx);
      expect(result!.prNumber).toBe(15);
      expect(result!.labels).toEqual(["kiln:implementation"]);
      expect(result!.payload).toBeDefined();
    });
  });
});
