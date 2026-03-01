import { GitHub } from "@actions/github/lib/utils";
import { Context } from "@actions/github/lib/context";

export type Octokit = InstanceType<typeof GitHub>;

export interface KilnConfig {
  protected_paths: string[];
  human_review: {
    spec: string;
    implementation: string;
  };
  auto_merge: boolean;
  timeout_minutes: number;
  labels: {
    prefix: string;
  };
  agents: {
    triage: { enabled: boolean };
    spec: { enabled: boolean; template?: string };
    implement: { enabled: boolean; run_tests: boolean; run_lint: boolean };
    review: { enabled: boolean; auto_approve: boolean };
    fix: { enabled: boolean; max_iterations: number };
  };
  spec_template?: string;
}

export interface KilnContext {
  octokit: Octokit;
  context: Context;
  config: KilnConfig;
  anthropicKey: string;
  timeoutMinutes: number;
  token: string;
}

export interface RouteResult {
  stage: string;
  issueNumber?: number;
  prNumber?: number;
  labels: string[];
  payload: Record<string, unknown>;
}

export interface StageResult {
  status: string;
  nextStage?: string;
  prNumber?: number;
  reason?: string;
  verdict?: string;
  iteration?: number;
}
