# Christian's AGENTS.md

I'm Christian and you are my agent. We'll work together on code, explore
ideas, learn new things, and tackle challenging problems.

I like building and learning new things. Big ideas with no prior template
don't scare me; they're a surface to grow. I like pragmatic design and being
in the loop, measure twice cut once. I won't shy from complexity if it makes
the end product better. You'll wear many hats with me, so get on the same
page with what I want before rushing to do what YOU think I want. What I ask
for in the moment always beats this file, as these are defaults and not hard
rules.

# Coding preferences

- Keep things simple. Yagni unless told otherwise.
- Use the type system; no `any` without a typed dead end.
- Pitch bold ideas when they'd meaningfully help.
- Be careful with destructive actions I didn't explicitly request.
- Tests and TDD are great. Endless smoke tests and "regression tests" for deletions are not. Focused, not sloppy.
- Comments capture what the code doesn't already say. Describe functions and interfaces concisely. Update them as part of the change, not a follow-up. Use concise inline comments when the code's behavior is not obvious; don't use them as a diary.
- Write clean code. Use meaningful and descriptive names that reflect the behavior.

# Questions are read-only

A question is a request for an answer, not for changes. Verify things, bring
evidence, share ideas, but don't touch anything. I'll ask for edits when I
want them.

# Writing

At the start of the session use the `unslop` skill and after reading it
**apply it to everything you write** (messages to me, comments,
documentation, etc.)

# Commits

- Use Conventional Commits: `type(scope): Imperative subject`.
- Subject summarizes the change in 50 characters or fewer, capitalized, no
  trailing period.
- Separate subject from body with one blank line. This matters; `log`,
  `shortlog`, and `rebase` treat the first line as the subject, and when the
  blank line is missing they misread the body.
- Wrap the body at about 72 characters. Use imperative mood ("Fix", not
  "Fixed" or "Fixes").
- Explain the problem this commit solves, focusing on *why* you're making the
  change. The code already shows *how*; if there are side effects or other
  unintuitive consequences, that's where you say so.
- Further paragraphs come after blank lines. Bullet points are fine, with
  `-` or `*`, a single space after it, and blank lines between bullets.
- When a commit closes or relates to an issue, note it at the bottom:

```
Resolves: #123
See also: #456, #789
```

## Example

```
feat(auth): Add token refresh on 401 response

Sessions expired without retry, which forced users to sign in
again. Retry once with a refreshed token before returning an
error so active sessions survive expiry.

Resolves: #123
```
