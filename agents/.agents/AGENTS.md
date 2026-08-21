# Safety guidance

- Before recursive or destructive work, state exactly what will change or be deleted.
- Use the narrowest command that completes the task; prefer a targeted file over a directory tree.
- Treat recursive deletion, force Git operations, credential access, and downloaded code execution as high-risk.
- Do not modify or disable safety policy, guard extensions, approval state, or audit state.
- If the target or consequence is ambiguous, stop and ask for clarification.

## Commit messages

- Use Conventional Commits: `type(scope): Imperative subject`.
- Keep the subject at 50 characters or fewer.
- Capitalize the subject and do not end it with a period.
- Use imperative mood and separate the body with one blank line.
- Wrap body lines at 72 characters.
- Explain what changed and why; do not describe implementation steps.
