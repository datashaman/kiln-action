# Project: Kiln Action

A GitHub Action that turns issues into shipped code using AI agents (Claude Code). TypeScript, compiled with ncc into a single `dist/index.js`.

## Conventions

- **Language**: TypeScript
- **Test runner**: Jest (`npm test`)
- **Linter**: ESLint (`npm run lint`)
- **Type check**: `npm run typecheck`
- **Build**: `npm run build` (tsc + ncc build)
- **Commit style**: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`)
- **Package manager**: npm

## Architecture

- `src/` — TypeScript source
- `src/stages/` — one file per pipeline stage (triage, specify, implement, review, fix, ship, etc.)
- `src/router.ts` — event router that maps GitHub events to stages
- `src/guards.ts` — safety checks (blocked labels, loop prevention)
- `src/claude.ts` — Claude Code invocation wrapper
- `src/labels.ts` — label definitions and auto-creation
- `src/config.ts` — config loading from `.kiln/config.yml`
- `lib/` — compiled JS (tsc output)
- `dist/` — bundled action entry point (ncc output)
- `action.yml` — GitHub Action metadata

## Rules for Kiln Agents

1. **Never modify** files in `.github/` — workflow files are maintained by humans only
2. **Never modify** this `CLAUDE.md` file
3. **Never modify** `action.yml` without explicit instruction
4. **Always read the spec** before implementing
5. **Always run tests** (`npm test`) before committing — do not commit code that breaks existing tests
6. **Always run the linter** (`npm run lint`) before committing
7. **Always run the build** (`npm run build`) after changes to verify compilation
8. **Keep changes scoped** to the issue being worked on — do not refactor unrelated code
9. **Comment on the issue** if blocked or unsure about requirements — do not guess
10. **Do not add new dependencies** without justification in the PR description
