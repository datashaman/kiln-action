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

Kiln auto-creates these labels on first run:

| Label | Meaning |
|---|---|
| `kiln:specifying` | Spec agent is working |
| `kiln:spec-review` | Waiting for human approval |
| `kiln:implementing` | Code agent is building |
| `kiln:in-review` | PR under AI review |
| `kiln:done` | Shipped |
| `kiln:blocked` | Emergency stop — halts all automation |

## Safety

- **Human gate**: Spec must be approved before implementation starts
- **Emergency stop**: Add `kiln:blocked` label to any issue to halt
- **Scope lock**: Agents cannot modify `.github/`, `CLAUDE.md`, or configured protected paths
- **Timeouts**: Each agent has a configurable timeout (default 30 min)
- **Conventional commits**: All AI commits follow conventional commit format

## License

MIT
