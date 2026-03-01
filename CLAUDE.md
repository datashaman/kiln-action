# Project: Kiln

AI-powered dev pipeline — issue in, release out. Pure GitHub Actions workflow, no compiled code.

## Architecture

- `.github/workflows/kiln.yml` — One job per pipeline stage (triage, retriage, specify, approve-spec, implement, review, fix, ship)
- `.kiln/prompts/*.md` — Prompt templates with `${VAR}` placeholders, substituted via `envsubst` at runtime
- `.kiln/spec-template.md` — Default structure for specification documents
- `.kiln/config.yml` — Optional repo-level configuration (label prefix, auto-merge, timeouts, etc.)

## Pipeline Stages

1. **Triage** — Classify new issues (type, complexity, clarity)
2. **Re-triage** — Re-evaluate after author comments on needs-info issues
3. **Specify** — Write a technical spec from the issue, open spec PR
4. **Approve-spec** — Merge spec PR on human approval, trigger implementation
5. **Implement** — Build code from the spec, open implementation PR
6. **Review** — AI code review of implementation PRs
7. **Fix** — Address review feedback (up to max_iterations)
8. **Ship** — Merge approved PRs when CI passes, close linked issues

## Conventions

- **Commit style**: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`)
- **Config**: YAML via `yq` — `yq '.key // "default"' .kiln/config.yml`
- **GitHub ops**: `gh` CLI for all issue/PR/label/review operations
- **Claude invocation**: Read-only (`claude --print --dangerously-skip-permissions`), edit mode (`claude --dangerously-skip-permissions`)

## Rules for Kiln Agents

1. **Never modify** files in `.github/` — workflow files are maintained by humans only
2. **Never modify** this `CLAUDE.md` file
3. **Never modify** `.kiln/prompts/` or `.kiln/config.yml` without explicit instruction
4. **Always read the spec** before implementing
5. **Keep changes scoped** to the issue being worked on — do not refactor unrelated code
6. **Comment on the issue** if blocked or unsure about requirements — do not guess
