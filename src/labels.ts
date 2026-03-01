import * as core from "@actions/core";
import { Context } from "@actions/github/lib/context";
import { Octokit, KilnConfig } from "./types";

const PREFIXED_LABELS = [
  {
    suffix: "intake",
    color: "c5def5",
    description: "Kiln: issue received, awaiting triage",
  },
  {
    suffix: "needs-info",
    color: "fbca04",
    description: "Kiln: waiting for clarification from author",
  },
  {
    suffix: "specifying",
    color: "c5def5",
    description: "Kiln: spec agent is writing the spec",
  },
  { suffix: "spec", color: "c5def5", description: "Kiln: spec PR" },
  {
    suffix: "spec-review",
    color: "fbca04",
    description: "Kiln: waiting for human spec approval",
  },
  {
    suffix: "implementing",
    color: "0e8a16",
    description: "Kiln: code agent is building",
  },
  {
    suffix: "implementation",
    color: "0e8a16",
    description: "Kiln: implementation PR",
  },
  {
    suffix: "in-review",
    color: "e4e669",
    description: "Kiln: under AI code review",
  },
  {
    suffix: "done",
    color: "0e8a16",
    description: "Kiln: shipped and closed",
  },
  {
    suffix: "blocked",
    color: "d93f0b",
    description: "Kiln: emergency stop — all automation halts",
  },
];

const STANDALONE_LABELS = [
  {
    name: "needs-human-review",
    color: "fbca04",
    description: "Kiln: requires human review before proceeding",
  },
  {
    name: "needs-review",
    color: "fbca04",
    description: "Kiln: awaiting AI code review",
  },
];

const TYPE_LABELS = [
  { suffix: "feature", color: "0075ca", description: "Type: new feature" },
  { suffix: "bug", color: "d73a4a", description: "Type: bug fix" },
  {
    suffix: "improvement",
    color: "a2eeef",
    description: "Type: improvement to existing feature",
  },
  {
    suffix: "chore",
    color: "cfd3d7",
    description: "Type: maintenance or chore",
  },
];

const SIZE_LABELS = [
  { suffix: "xs", color: "009800", description: "Size: extra small" },
  { suffix: "s", color: "77bb00", description: "Size: small" },
  { suffix: "m", color: "fbca04", description: "Size: medium" },
  { suffix: "l", color: "eb6420", description: "Size: large" },
  { suffix: "xl", color: "b60205", description: "Size: extra large" },
];

export async function ensureLabels(
  octokit: Octokit,
  context: Context,
  config: KilnConfig,
): Promise<void> {
  const prefix = config.labels?.prefix || "kiln";

  const { data: existing } = await octokit.rest.issues.listLabelsForRepo({
    ...context.repo,
    per_page: 100,
  });
  const existingNames = new Set(existing.map((l) => l.name));

  // Build the full list of labels to create
  const allLabels: Array<{ name: string; color: string; description: string }> =
    [];

  // Prefixed pipeline labels (e.g., kiln:specifying)
  for (const def of PREFIXED_LABELS) {
    allLabels.push({
      name: `${prefix}:${def.suffix}`,
      color: def.color,
      description: def.description,
    });
  }

  // Standalone PR marker labels
  for (const def of STANDALONE_LABELS) {
    allLabels.push(def);
  }

  // Type labels (type:feature, type:bug, etc.)
  for (const def of TYPE_LABELS) {
    allLabels.push({
      name: `type:${def.suffix}`,
      color: def.color,
      description: def.description,
    });
  }

  // Size labels (size:xs, size:s, etc.)
  for (const def of SIZE_LABELS) {
    allLabels.push({
      name: `size:${def.suffix}`,
      color: def.color,
      description: def.description,
    });
  }

  for (const label of allLabels) {
    if (!existingNames.has(label.name)) {
      try {
        await octokit.rest.issues.createLabel({
          ...context.repo,
          name: label.name,
          color: label.color,
          description: label.description,
        });
        core.info(`Created label: ${label.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Failed to create label ${label.name}: ${message}`);
      }
    }
  }
}

export async function transitionLabel(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  fromSuffix: string | null,
  toSuffix: string,
  prefix: string,
): Promise<void> {
  if (fromSuffix) {
    const oldLabel = `${prefix}:${fromSuffix}`;
    try {
      await octokit.rest.issues.removeLabel({
        ...context.repo,
        issue_number: issueNumber,
        name: oldLabel,
      });
    } catch {
      // Label might not exist, that's fine
    }
  }

  const newLabel = `${prefix}:${toSuffix}`;
  await octokit.rest.issues.addLabels({
    ...context.repo,
    issue_number: issueNumber,
    labels: [newLabel],
  });
}
