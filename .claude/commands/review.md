# Pre-Push Code Review

You are reviewing code that is about to be pushed to a PUBLIC repository. Security is the primary concern.

## Step 1: Gather the diff

```bash
git diff origin/main --stat
```

```bash
git diff origin/main
```

## Step 2: Scan for secrets (MANDATORY, always first)

Before any code review, scan the diff for exposed secrets:
- API keys, tokens, passwords, credentials
- Private URLs, internal hostnames, IP addresses
- OAuth client secrets, JWT secrets
- Patterns: `sk-`, `ghp_`, `gho_`, `AIza`, `ya29.`, `xoxb-`, `xoxp-`, `AKIA`
- `.env` file contents, cloud project IDs
- Hardcoded connection strings

If ANY secret is found, stop the review immediately and report it as a P0 blocker. Do not continue until the secret is removed from the diff.

## Step 3: Select agents based on diff size

**Small (1-50 lines):** Run core 4: security, logic, boundary, error-handling

**Medium (51-300 lines):** Core 4 + data-flow, contracts

**Large (300+ lines):** All 6 agents

Launch all selected agents in parallel using the Agent tool with subagent_type matching the agent name. Each agent prompt must include the full diff and the content of every changed file.

## Step 4: Synthesize

Collect all agent results. Deduplicate findings. Sort by severity.

### Severity levels

| Level | Meaning |
|-------|---------|
| **P0** | Must fix. Bugs, security holes, exposed secrets, data corruption. |
| **P1** | Should fix before push. Conditional problems. |
| **P2** | Should fix. Quality, maintainability, latent risk. |
| **P3** | Consider fixing. Minor improvements. |

### Output format

```markdown
## Pre-Push Review

**Scope**: [X files changed, +Y/-Z lines]
**Agents run**: [list]
**Secrets scan**: PASS / FAIL

**Verdicts**: `security: pass` | `logic: warn (2)` | ...

### P0 — Must Fix
- **#N** **[agent]** `file:line` — Description

### P1 — Should Fix Before Push
...

### P2 — Should Fix
...

### P3 — Consider
...
```

## Scope rules

- Review ONLY what changed in the diff against origin/main.
- Findings must reference specific lines.
- Do not suggest refactoring code that wasn't touched.
- The data-flow agent is the exception -- it searches beyond the diff for blast radius.
