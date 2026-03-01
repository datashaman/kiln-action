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

## Quick Start

### 1. Add your API key

Go to **Settings → Secrets → Actions** and add:
- `ANTHROPIC_API_KEY` — your Anthropic API key

### 2. Create the workflow

Add **one file** to your repo:

```yaml
# .github/workflows/kiln.yml
name: "🔥 Kiln"

on:
  issues:
    types: [opened, labeled]
  pull_request:
    types: [opened, synchronize]
  pull_request_review:
    types: [submitted]
  issue_comment:
    types: [created]

permissions:
  issues: write
  contents: write
  pull-requests: write

jobs:
  kiln:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: your-org/kiln-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

That's it. Create an issue and watch it fire.

### 3. (Optional) Add a config file

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

## Stages

| Stage | Trigger | What happens |
|---|---|---|
| **Triage** | Issue opened | Classifies type/size, checks clarity, labels for next stage |
| **Specify** | Label `kiln:specifying` | Reads codebase + issue, writes spec, opens spec PR |
| **Spec Review** | Spec PR opened | Waits for human approval |
| **Implement** | Spec PR approved | Reads spec, writes code + tests, opens impl PR |
| **Review** | Impl PR opened | AI reviews against spec, approves or requests changes |
| **Fix** | Changes requested | Addresses review feedback, pushes fixes |
| **Ship** | Approved + CI green | Auto-merges, closes issue |

## Configuration Reference

See [docs/configuration.md](docs/configuration.md) for full config options.

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

## Safety

- **Human gate**: Spec must be approved before implementation starts
- **Emergency stop**: Add `kiln:blocked` label to any issue to halt
- **Scope lock**: Agents cannot modify `.github/`, `CLAUDE.md`, or configured protected paths
- **Timeouts**: Each agent has a configurable timeout (default 30 min)
- **Conventional commits**: All AI commits follow conventional commit format

## License

MIT
