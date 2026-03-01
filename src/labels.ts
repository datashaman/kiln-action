import * as core from "@actions/core";
import { Context } from "@actions/github/lib/context";
import { Octokit, KilnConfig } from "./types";

const LABEL_DEFS = [
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

  for (const def of LABEL_DEFS) {
    const name = `${prefix}:${def.suffix}`;
    if (!existingNames.has(name)) {
      try {
        await octokit.rest.issues.createLabel({
          ...context.repo,
          name,
          color: def.color,
          description: def.description,
        });
        core.info(`Created label: ${name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Failed to create label ${name}: ${message}`);
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
