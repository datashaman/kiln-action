import * as core from "@actions/core";
import * as github from "@actions/github";
import { checkBlocked } from "./blocked";
import { loadConfig } from "./config";
import { isBotActor, postStageError } from "./guards";
import { ensureLabels } from "./labels";
import { detectStage } from "./router";
import { KilnContext, StageResult } from "./types";

import triage from "./stages/triage";
import retriage from "./stages/retriage";
import specify from "./stages/specify";
import approveSpec from "./stages/approve-spec";
import implement from "./stages/implement";
import review from "./stages/review";
import fix from "./stages/fix";
import ship from "./stages/ship";

type StageHandler = (ctx: KilnContext) => Promise<StageResult>;

const STAGES: Record<string, StageHandler> = {
  triage,
  "re-triage": retriage,
  specify,
  "approve-spec": approveSpec,
  implement,
  review,
  fix,
  release: ship,
};

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

    // AC2: Label events triggered by Kiln itself don't cause duplicate stage runs
    if (isBotActor(context)) {
      core.info(
        `🔥 Kiln — Skipping: event triggered by bot (${(context.payload.sender as { login?: string })?.login})`,
      );
      core.setOutput("stage", "none");
      core.setOutput("result", "skipped");
      return;
    }

    if (await checkBlocked(octokit, context, config)) {
      core.info("🛑 Kiln is blocked on this issue. Skipping.");
      core.setOutput("stage", "none");
      core.setOutput("result", "blocked");
      return;
    }

    let stage: string | null;

    if (forceStage !== "auto") {
      stage = forceStage;
    } else {
      const route = detectStage(context);
      stage = route?.stage ?? null;
    }

    if (!stage) {
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

    // AC3: Stage failures post error comment and don't advance pipeline
    let result: StageResult;
    try {
      result = await handler(ctx);
    } catch (stageError) {
      const errorMsg =
        stageError instanceof Error ? stageError.message : String(stageError);
      core.error(`🔥 Kiln — Stage "${stage}" failed: ${errorMsg}`);
      await postStageError(octokit, context, stage, errorMsg);
      core.setOutput("stage", stage);
      core.setOutput("result", "error");
      core.setFailed(`🔥 Kiln — Stage "${stage}" failed: ${errorMsg}`);
      return;
    }

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
