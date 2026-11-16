---
description: Read-only multi-agent analysis of a project — no cells, no edits, cited report
---

You are running a **read-only analysis swarm**. The user wants to understand a
project, not change it. Nothing in this flow may write to the repository: no
edits, no worktrees, no cells, no verification gates.

Safe to run from **Plan mode** or from a normal agent: every worker you spawn is
`swarm-analyst`, which is denied `edit`, `shell` and `subagent` by permission.

## Task

$ARGUMENTS

## Flow

### Phase 0 — Scope (one question, only if genuinely ambiguous)

What do they want to understand? Examples: "the auth flow", "how billing
works", "what this service actually does", "where the data comes from".
If the request is already specific, do not ask.

### Phase 1 — Prior knowledge

```
hivemind_find(query="<topic> <project name>", limit=5)
```

Skip anything already answered; start the report from what is known.

### Phase 2 — Choose 3 to 6 lenses

Pick lenses, not tasks. Default set for a codebase:

| Lens | Question it answers |
|---|---|
| architecture | What are the main components and how do they talk? |
| data model | What is stored, where, and who owns it? |
| entry points | How does work enter the system (routes, jobs, CLIs)? |
| integrations | Which external services matter and how are they called? |
| risks | What breaks first under load or misuse? |
| tests | What is actually covered, what is not? |

Adapt: a library gets "public API" and "extension points"; a data pipeline gets
"inputs", "transformations", "outputs".

### Phase 3 — Spawn analysts (parallel, read-only)

For each lens:

```
subagent(
  agent="swarm-analyst",
  description="Analyse: <lens>",
  prompt="Project: <absolute path>. Lens: <lens>. Question: <one sentence>.
          Read-only: cite path:line for every claim, max 30 lines, and store
          1-3 durable findings with hivemind_store (tags: analysis,<project>,<lens>)."
)
```

Spawn them in one batch. Do not sequence them unless a lens depends on another's
answer. If a worker returns "Not verified" for something essential, you may run
the shell command yourself (you still have `shell`) — never ask the worker to.

### Phase 4 — Report

Merge the lenses into one answer, in this order:

1. **What it is** — 2 sentences.
2. **How it works** — per lens, bullets with `path:line`.
3. **Data & integrations** — only if relevant.
4. **Risks** — ranked, each with the evidence that supports it.
5. **Not verified** — honest gaps, so the user knows what to trust.

Then store the synthesis once:

```
hivemind_store(information="<project>: <5-10 line synthesis>", tags="analysis,<project>,synthesis")
```

### Phase 5 — Optional report file

If the user asked for a written report (`--report <slug>`), write it to
`~/.opencode/plan/<slug>.md` — this is the only permitted write, and Plan mode
allows it explicitly. Otherwise answer in the conversation.

## Hard rules

- **Never** call `hive_create_epic`, `swarm_decompose`, `swarm_spawn_subtask`,
  `swarm_complete`, `swarm_review`, `swarm_verify` or any worktree tool.
- **Never** edit or write a project file.
- **Never** invent code you did not read. "Not verified" is a valid answer.
- If the project path is unclear, resolve it with `glob`/`read` first; do not ask
  the user for a path.
