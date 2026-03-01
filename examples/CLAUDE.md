# Project: [Your Project Name]

<!--
  CLAUDE.md template for Kiln

  This is a starting point — customize every section to match your project.
  Kiln's AI agents (spec, implementation, review, fix) read this file to
  understand your project's conventions and constraints.

  Delete these comments once you've filled in your details.
-->

## Project Description

<!-- Briefly describe what this project does, its tech stack, and any important context
     that an AI agent would need to understand before making changes. -->

[Describe your project here. Include the main language/framework, what the project does,
and any architectural context that would help an agent navigate the codebase.]

## Conventions

- **Language**: [e.g., TypeScript, Python 3.12, Go 1.22]
- **Test runner**: [e.g., Jest (`npm test`), pytest (`pytest`), `go test ./...`]
- **Linter**: [e.g., ESLint (`npm run lint`), ruff (`ruff check .`), golangci-lint]
- **Commit style**: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`)
- **Package manager**: [e.g., npm, pnpm, poetry, cargo]
- **Build command**: [e.g., `npm run build`, `make`, `cargo build`]

<!-- Add any other conventions your project follows:
- Code formatting (Prettier, Black, gofmt)
- Branch naming
- PR conventions
- Documentation requirements
-->

## Rules for Kiln Agents

1. **Never modify** files in `.github/` — workflow files are maintained by humans only
2. **Never modify** this `CLAUDE.md` file
3. **Always read the spec** (`specs/issue-{number}.md`) before implementing
4. **Always run tests** before committing — do not commit code that breaks existing tests
5. **Keep changes scoped** to the issue being worked on — do not refactor unrelated code
6. **Comment on the issue** if blocked or unsure about requirements — do not guess

<!-- Add project-specific rules below. Examples:
- Never modify the database schema directly — use migrations
- Always add tests for new public functions
- Do not add new dependencies without justification in the PR description
- Keep bundle size under [X] KB
- All API endpoints must include input validation
- Use [specific pattern] for error handling
-->
