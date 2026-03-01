import * as core from "@actions/core";
import * as github from "@actions/github";
import { loadConfig } from "./config";
import { ensureLabels } from "./labels";
import { detectStage } from "./router";
import { KilnContext, StageResult } from "./types";

import triage from "./stages/triage";
import specify from "./stages/specify";
import approveSpec from "./stages/approve-spec";
import implement from "./stages/implement";
import review from "./stages/review";
import fix from "./stages/fix";
import ship from "./stages/ship";

type StageHandler = (ctx: KilnContext) => Promise<StageResult>;

const STAGES: Record<string, StageHandler> = {
  triage,
  specify,
  "approve-spec": approveSpec,
  implement,
  review,
  fix,
  ship,
};

async function isBlocked(
  octokit: KilnContext["octokit"],
  context: KilnContext["context"],
  config: KilnContext["config"],
): Promise<boolean> {
  const prefix = config.labels?.prefix || "kiln";
  const blockedLabel = `${prefix}:blocked`;

  let issueNumber = context.payload.issue?.number as number | undefined;
  if (!issueNumber && context.payload.pull_request) {
    const match = (
      context.payload.pull_request.body as string | undefined
    )?.match(/Closes #(\d+)/);
    if (match) issueNumber = parseInt(match[1], 10);
  }

  if (!issueNumber) return false;

  try {
    const { data: issue } = await octokit.rest.issues.get({
      ...context.repo,
      issue_number: issueNumber,
    });
    return issue.labels.some(
      (l) => (typeof l === "string" ? l : l.name) === blockedLabel,
    );
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  try {
    const token = core.getInput("github_token");
    const anthropicKey = core.getInput("anthropic_api_key");
    const configPath = core.getInput("config_path");
    const forceStage = core.getInput("stage");
    const timeoutMinutes = parseInt(core.getInput("timeout_minutes"), 10);

    const octokit = github.getOctokit(token);
    const context = github.context;

    const config = await loadConfig(configPath);

    await ensureLabels(octokit, context, config);

    if (await isBlocked(octokit, context, config)) {
      core.info("🛑 Kiln is blocked on this issue. Skipping.");
      core.setOutput("stage", "none");
      core.setOutput("result", "blocked");
      return;
    }

    const stage = forceStage !== "auto" ? forceStage : detectStage(context);

    if (!stage) {
      core.info("🔥 Kiln — No matching stage for this event. Skipping.");
      core.setOutput("stage", "none");
      core.setOutput("result", "skipped");
      return;
    }

    core.info(`🔥 Kiln — Running stage: ${stage}`);

    const handler = STAGES[stage];
    if (!handler) {
      core.setFailed(`Unknown stage: ${stage}`);
      return;
    }

    const ctx: KilnContext = {
      octokit,
      context,
      config,
      anthropicKey,
      timeoutMinutes,
      token,
    };

    const result = await handler(ctx);

    core.setOutput("stage", stage);
    core.setOutput("result", result?.status || "success");
    if (result?.prNumber) {
      core.setOutput("pr_number", result.prNumber.toString());
    }

    core.info(`🔥 Kiln — Stage "${stage}" completed.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`🔥 Kiln failed: ${message}`);
  }
}

run();
