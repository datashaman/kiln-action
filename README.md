# 🔥 Kiln

> Raw ideas in. Finished releases out.

A GitHub Action that turns issues into shipped code using AI agents (Claude Code). Drop it into any repo with a single workflow file.

## How it works

```
 You create an Issue
       │
       ▼
 [Triage] → classifies, labels
       │
       ▼
 [Spec Agent] → writes spec → opens PR
       │
       ▼
 ★ YOU review + approve spec ★
       │
       ▼
 [Impl Agent] → writes code + tests → opens PR
       │
       ▼
 [Review Agent] → reviews → approves or requests changes
       │                            │
       │                    [Fix Agent] → pushes fixes
       │                            │
       ◀────────────────────────────┘
       │
       ▼
 CI passes + approved → auto-merge
       │
       ▼
 🔥 Shipped.
```

## Getting Started

### 1. Add your API key

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key for Claude |

### 2. Create the workflow

Add **one file** to your repo at `.github/workflows/kiln.yml`:

```yaml
# .github/workflows/kiln.yml
name: "🔥 Kiln"

on:
  # Triage: classify new issues
  issues:
    types: [opened, labeled]

  # Re-triage: re-evaluate after author replies
  issue_comment:
    types: [created]

  # Review: AI reviews new/updated implementation PRs
  pull_request:
    types: [opened, synchronize]

  # Approve-spec, Fix, Ship: respond to PR review events
  pull_request_review:
    types: [submitted]

  # Ship: auto-merge when CI passes
  check_suite:
    types: [completed]

permissions:
  issues: write
  contents: write
  pull-requests: write

jobs:
  kiln:
    runs-on: ubuntu-latest
    # Don't run on events triggered by Kiln itself
    if: github.actor != 'github-actions[bot]'
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: datashaman/kiln-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

A standalone copy of this workflow is also available at [`templates/workflow.yml`](templates/workflow.yml).

### 3. Create labels

Labels are created automatically on Kiln's first run. To create them in advance, see the [Labels](#labels) section.

### 4. Add a CLAUDE.md (recommended)

Create a `CLAUDE.md` file in your repo root to guide Kiln's AI agents. This file tells the agents about your project's conventions:

```markdown
# Project: My App

## Conventions
- Language: TypeScript
- Test runner: Jest (`npm test`)
- Linter: ESLint (`npm run lint`)
- Commit style: Conventional Commits (feat:, fix:, chore:)

## Rules for Kiln Agents
- Never modify files in `.github/` or `.env`
- Never modify this CLAUDE.md file
- Always read the spec before implementing
- Always run tests before committing
- Keep changes scoped to the issue being worked on
- If blocked or unsure, comment on the issue explaining why
```

This is a starting point — customize every section to match your project. The spec and implementation agents will follow these instructions.

A more detailed template with additional guidance is available at [`examples/CLAUDE.md`](examples/CLAUDE.md).

## Stages

| Stage | Trigger | What happens |
|---|---|---|
| **Triage** | Issue opened | Classifies type/size, checks clarity, labels for next stage |
| **Re-triage** | Comment on needs-info issue | Re-evaluates clarity after author responds |
| **Specify** | Label `kiln:specifying` | Reads codebase + issue, writes spec, opens spec PR |
| **Spec Review** | Spec PR opened | Waits for human approval |
| **Implement** | Spec PR approved | Reads spec, writes code + tests, opens impl PR |
| **Review** | Impl PR opened/updated | AI reviews against spec, approves or requests changes |
| **Fix** | Changes requested | Addresses review feedback, pushes fixes |
| **Ship** | Approved + CI green | Auto-merges, closes issue |

## Configuration Reference

Kiln is configured via `.kiln/config.yml` in your repo root. All settings are optional — Kiln works out of the box with sensible defaults.

```yaml
# .kiln/config.yml
spec_template: .kiln/spec-template.md
protected_paths:
  - .github/
  - .env
  - CLAUDE.md
human_review:
  spec: required        # always require human spec approval
  implementation: auto  # AI review is sufficient
auto_merge: true
timeout_minutes: 30
labels:
  prefix: "kiln"        # kiln:specifying, kiln:implementing, etc.
```

For full configuration details, see [docs/configuration.md](docs/configuration.md).

## Labels

Kiln auto-creates all required labels on first run. You can also create them manually using the setup script below.

### Pipeline State

| Label | Color | Hex | Description |
|---|---|---|---|
| `kiln:intake` | ![#c5def5](https://via.placeholder.com/12/c5def5/c5def5.png) | `#c5def5` | Issue received, awaiting triage |
| `kiln:needs-info` | ![#fbca04](https://via.placeholder.com/12/fbca04/fbca04.png) | `#fbca04` | Waiting for clarification from author |
| `kiln:specifying` | ![#c5def5](https://via.placeholder.com/12/c5def5/c5def5.png) | `#c5def5` | Spec agent is writing the spec |
| `kiln:spec-review` | ![#fbca04](https://via.placeholder.com/12/fbca04/fbca04.png) | `#fbca04` | Waiting for human spec approval |
| `kiln:implementing` | ![#0e8a16](https://via.placeholder.com/12/0e8a16/0e8a16.png) | `#0e8a16` | Code agent is building |
| `kiln:in-review` | ![#e4e669](https://via.placeholder.com/12/e4e669/e4e669.png) | `#e4e669` | Under AI code review |
| `kiln:done` | ![#0e8a16](https://via.placeholder.com/12/0e8a16/0e8a16.png) | `#0e8a16` | Shipped and closed |
| `kiln:blocked` | ![#d93f0b](https://via.placeholder.com/12/d93f0b/d93f0b.png) | `#d93f0b` | Emergency stop — all automation halts |

### PR Markers

| Label | Color | Hex | Description |
|---|---|---|---|
| `kiln:spec` | ![#c5def5](https://via.placeholder.com/12/c5def5/c5def5.png) | `#c5def5` | Spec PR |
| `kiln:implementation` | ![#0e8a16](https://via.placeholder.com/12/0e8a16/0e8a16.png) | `#0e8a16` | Implementation PR |
| `needs-human-review` | ![#fbca04](https://via.placeholder.com/12/fbca04/fbca04.png) | `#fbca04` | Requires human review before proceeding |
| `needs-review` | ![#fbca04](https://via.placeholder.com/12/fbca04/fbca04.png) | `#fbca04` | Awaiting AI code review |

### Type (applied by triage)

| Label | Color | Hex | Description |
|---|---|---|---|
| `type:feature` | ![#0075ca](https://via.placeholder.com/12/0075ca/0075ca.png) | `#0075ca` | New feature |
| `type:bug` | ![#d73a4a](https://via.placeholder.com/12/d73a4a/d73a4a.png) | `#d73a4a` | Bug fix |
| `type:improvement` | ![#a2eeef](https://via.placeholder.com/12/a2eeef/a2eeef.png) | `#a2eeef` | Improvement to existing feature |
| `type:chore` | ![#cfd3d7](https://via.placeholder.com/12/cfd3d7/cfd3d7.png) | `#cfd3d7` | Maintenance or chore |

### Size (applied by triage)

| Label | Color | Hex | Description |
|---|---|---|---|
| `size:xs` | ![#009800](https://via.placeholder.com/12/009800/009800.png) | `#009800` | Extra small |
| `size:s` | ![#77bb00](https://via.placeholder.com/12/77bb00/77bb00.png) | `#77bb00` | Small |
| `size:m` | ![#fbca04](https://via.placeholder.com/12/fbca04/fbca04.png) | `#fbca04` | Medium |
| `size:l` | ![#eb6420](https://via.placeholder.com/12/eb6420/eb6420.png) | `#eb6420` | Large |
| `size:xl` | ![#b60205](https://via.placeholder.com/12/b60205/b60205.png) | `#b60205` | Extra large |

### Manual Setup

Labels are created automatically on first run. To create them manually, use the GitHub CLI:

```bash
# Pipeline state labels
gh label create "kiln:intake" --color "c5def5" --description "Kiln: issue received, awaiting triage"
gh label create "kiln:needs-info" --color "fbca04" --description "Kiln: waiting for clarification from author"
gh label create "kiln:specifying" --color "c5def5" --description "Kiln: spec agent is writing the spec"
gh label create "kiln:spec-review" --color "fbca04" --description "Kiln: waiting for human spec approval"
gh label create "kiln:implementing" --color "0e8a16" --description "Kiln: code agent is building"
gh label create "kiln:in-review" --color "e4e669" --description "Kiln: under AI code review"
gh label create "kiln:done" --color "0e8a16" --description "Kiln: shipped and closed"
gh label create "kiln:blocked" --color "d93f0b" --description "Kiln: emergency stop — all automation halts"

# PR marker labels
gh label create "kiln:spec" --color "c5def5" --description "Kiln: spec PR"
gh label create "kiln:implementation" --color "0e8a16" --description "Kiln: implementation PR"
gh label create "needs-human-review" --color "fbca04" --description "Kiln: requires human review before proceeding"
gh label create "needs-review" --color "fbca04" --description "Kiln: awaiting AI code review"

# Type labels
gh label create "type:feature" --color "0075ca" --description "Type: new feature"
gh label create "type:bug" --color "d73a4a" --description "Type: bug fix"
gh label create "type:improvement" --color "a2eeef" --description "Type: improvement to existing feature"
gh label create "type:chore" --color "cfd3d7" --description "Type: maintenance or chore"

# Size labels
gh label create "size:xs" --color "009800" --description "Size: extra small"
gh label create "size:s" --color "77bb00" --description "Size: small"
gh label create "size:m" --color "fbca04" --description "Size: medium"
gh label create "size:l" --color "eb6420" --description "Size: large"
gh label create "size:xl" --color "b60205" --description "Size: extra large"
```

## Safety Controls

### Emergency Stop

Add the `kiln:blocked` label to any issue or PR to immediately halt all Kiln automation on that item. Kiln will post a comment confirming automation is paused. Remove the label to resume.

For PR events, Kiln checks both the PR labels and the linked issue labels for `kiln:blocked`, so blocking the issue also stops PR automation.

### Human Spec Approval Gate

By default, Kiln requires a human to approve every spec PR before implementation begins. This ensures you control what gets built. Set `human_review.spec: optional` in config to skip this gate (not recommended).

### Protected Paths

Agents are instructed to never modify files in protected paths. Defaults: `.github/`, `.env`, `CLAUDE.md`, `.kiln/`. Configure via `protected_paths` in `.kiln/config.yml`.

### Branch Protections

For additional safety, enable GitHub branch protection rules on `main`:
- Require pull request reviews before merging
- Require status checks to pass before merging
- Restrict who can push to matching branches

These complement Kiln's built-in controls and prevent any direct pushes to main.

### Timeouts

Each AI agent has a configurable timeout (default: 30 minutes). If an agent exceeds the timeout, it is killed and Kiln posts an error comment on the issue/PR with advice to increase `timeout_minutes` in config. Adjust via `timeout_minutes` in `.kiln/config.yml` or the `timeout_minutes` action input.

### Conventional Commits

All AI commits follow conventional commit format (`feat:`, `fix:`, `chore:`, etc.), keeping your git history clean and parseable.

### Loop Prevention

Kiln includes built-in safeguards against infinite loops:
- Bot/action comments are ignored during re-triage (prevents triage loops)
- Label events triggered by Kiln itself are debounced via actor checks
- Duplicate spec/implementation PRs are detected and skipped
- The fix agent has a configurable max iteration limit (default: 3)

## Troubleshooting

### Kiln isn't responding to new issues

- **Missing secret**: Ensure `ANTHROPIC_API_KEY` is set in **Settings → Secrets and variables → Actions**. Kiln will fail silently if the key is missing.
- **Workflow not triggered**: Verify `.github/workflows/kiln.yml` exists and listens on `issues: [opened, labeled]`. Check the **Actions** tab to see if the workflow ran.
- **Actor filter**: The workflow template includes `if: github.actor != 'github-actions[bot]'`. If you're testing with a bot account, this will skip execution.

### Labels aren't being created

- **Permissions**: Ensure the workflow has `issues: write` permission. Label creation requires write access.
- **First run**: Labels are created on Kiln's first execution. If the first run failed (e.g., missing API key), labels won't exist yet. Fix the error and re-trigger, or create labels manually using the [setup script](#manual-setup).

### Spec/implementation PRs aren't being created

- **Missing permissions**: Ensure `contents: write` and `pull-requests: write` are set in the workflow permissions.
- **Missing checkout**: The workflow must include `actions/checkout@v4` with `fetch-depth: 0` before the Kiln step.
- **Branch already exists**: If a previous run partially completed, the branch may already exist. Delete the stale branch and re-trigger by re-applying the label.

### AI review isn't running on PRs

- **Missing trigger**: Ensure the workflow listens on `pull_request: [opened, synchronize]`.
- **Missing label**: AI review only runs on PRs with the `kiln:implementation` label. Verify the label exists on the PR.

### Auto-merge isn't working

- **Missing check_suite trigger**: Ensure the workflow listens on `check_suite: [completed]`. Without this, Kiln can't detect when CI passes.
- **CI not passing**: Kiln only merges when all CI checks are green. Check the PR's status checks.
- **No approval**: Kiln requires at least one approval on the PR before merging.
- **Disabled in config**: Check that `auto_merge` is not set to `false` in `.kiln/config.yml`.

### "Automation is blocked" message

- A `kiln:blocked` label is present on the issue or a linked PR. Remove the label to resume automation.

### Agent timing out

- Increase `timeout_minutes` in `.kiln/config.yml` or pass it as an action input. Large repos or complex specs may need more time.
- Default timeout is 30 minutes.

## License

MIT
