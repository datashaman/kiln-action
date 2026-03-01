# Configuration Reference

Kiln is configured via `.kiln/config.yml` in your repo root. All settings are optional.

## Full Config

```yaml
spec_template: .kiln/spec-template.md
protected_paths:
  - .github/
  - .env
  - CLAUDE.md
  - .kiln/
human_review:
  spec: required
  implementation: auto
auto_merge: true
timeout_minutes: 30
labels:
  prefix: kiln
agents:
  triage:
    enabled: true
  spec:
    enabled: true
    template: null
  implement:
    enabled: true
    run_tests: true
    run_lint: true
  review:
    enabled: true
    auto_approve: false
  fix:
    enabled: true
    max_iterations: 3
```

## Settings

### `spec_template`
**Type:** string (file path) · **Default:** built-in template

Path to a custom Markdown template for specs. The spec agent will use this
structure instead of the default. The template should include section headers
that the agent will fill in.

### `protected_paths`
**Type:** string[] · **Default:** `[".github/", ".env", "CLAUDE.md", ".kiln/"]`

Files and directories that agents are instructed to never modify. Agents receive
these as explicit constraints in their prompts. Use glob-style paths.

### `human_review.spec`
**Type:** `"required"` | `"optional"` · **Default:** `"required"`

Whether a human must approve the spec PR before implementation begins.
- `required` — Implementation won't start until a human approves the spec PR
- `optional` — AI-generated spec auto-advances (⚠️ use with caution)

### `human_review.implementation`
**Type:** `"auto"` | `"required"` · **Default:** `"auto"`

Who must approve the implementation PR before it can merge.
- `auto` — AI review is sufficient (if it approves and CI passes, it ships)
- `required` — A human must also approve

### `auto_merge`
**Type:** boolean · **Default:** `true`

Whether to automatically merge implementation PRs when approved + CI green.
Set to `false` to require manual merge.

### `timeout_minutes`
**Type:** number · **Default:** `30`

Maximum time each AI agent can run before being killed. Prevents runaway
API costs. Adjust higher for large/complex repos.

### `labels.prefix`
**Type:** string · **Default:** `"kiln"`

Prefix for all Kiln labels. Labels will be `{prefix}:specifying`,
`{prefix}:implementing`, etc. Change if `kiln:` conflicts with existing labels.

### `agents.*.enabled`
**Type:** boolean · **Default:** `true`

Disable specific stages. For example, set `agents.triage.enabled: false` to
skip triage and go straight to specifying when an issue is created.

### `agents.fix.max_iterations`
**Type:** number · **Default:** `3`

Maximum number of times the fix agent will attempt to address review feedback
before giving up and flagging for human intervention.

## Custom Spec Templates

Create a Markdown file with headers the spec agent should fill in:

```markdown
# Spec: {{title}}

## Problem Statement
What problem does this solve?

## Proposed Solution
High-level approach.

## Detailed Design
### API Changes
### Database Changes
### UI Changes

## Testing Strategy

## Rollback Plan

## Open Questions
```

Reference it in config:
```yaml
spec_template: .kiln/spec-template.md
```

## Branch Naming

Kiln uses these branch conventions (not configurable):

| Stage | Pattern |
|---|---|
| Spec | `kiln/spec/issue-{number}` |
| Implementation | `kiln/impl/issue-{number}` |

## Label Reference

Created automatically on first run:

| Label | Purpose |
|---|---|
| `{prefix}:specifying` | Spec agent is writing the spec |
| `{prefix}:spec` | Applied to spec PRs |
| `{prefix}:spec-review` | Waiting for human spec approval |
| `{prefix}:implementing` | Code agent is building |
| `{prefix}:implementation` | Applied to implementation PRs |
| `{prefix}:in-review` | Under AI code review |
| `{prefix}:done` | Shipped and closed |
| `{prefix}:blocked` | Emergency stop — all automation halts |
