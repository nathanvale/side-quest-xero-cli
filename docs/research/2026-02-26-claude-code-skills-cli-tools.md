# Claude Code Skills for CLI Tools -- Research Findings

**Date:** 2026-02-26
**Author:** Nathan Vale (with beat reporter research)
**Context:** Building a `xero-reconcile` skill that wraps the `xero-cli` binary

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Official SKILL.md Structure](#official-skillmd-structure)
3. [Skills vs MCP -- When to Use Which](#skills-vs-mcp----when-to-use-which)
4. [Anti-Hallucination Strategies](#anti-hallucination-strategies)
5. [Dynamic Context Injection](#dynamic-context-injection)
6. [Frontmatter Controls](#frontmatter-controls)
7. [Real-World Examples](#real-world-examples)
8. [Community Patterns and Discussion](#community-patterns-and-discussion)
9. [Local Codebase Findings](#local-codebase-findings)
10. [Recommendations for xero-reconcile](#recommendations-for-xero-reconcile)
11. [Sources](#sources)

---

## Executive Summary

Claude Code skills are the recommended mechanism for teaching Claude how to use local CLI tools. The community consensus is clear: **skills for methodology, MCP for connectivity**. Three anti-hallucination strategies have emerged -- `allowed-tools` scoping, wrapper simplification, and on-demand reference files. The official docs provide a `` !`command` `` dynamic injection feature that eliminates documentation staleness entirely.

---

## Official SKILL.md Structure

Source: [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)

The canonical file structure for a CLI-wrapping skill:

```
my-cli-skill/
+-- SKILL.md          # Overview + navigation only (<500 lines)
+-- reference.md      # Full flag/subcommand docs, loaded on demand
+-- examples.md       # Usage examples
+-- scripts/
    +-- validate.sh   # Executable scripts Claude can run
```

### Why the split matters

Skill **descriptions** are loaded into context at all times (~2% of context window, ~16K character fallback). Full skill content only loads on invocation. Putting exhaustive flag documentation in `reference.md` avoids burning tokens until the skill is actually called.

The official docs explicitly recommend this for CLI tools: "Reference supporting files from SKILL.md so Claude knows what they contain and when to load them." This is the primary anti-hallucination mechanism -- the model reads authoritative docs rather than inventing flags from training data.

### SKILL.md frontmatter format

```yaml
---
name: kebab-case-skill-name
description: >
  [What it does] + [When to use it] + [Key capabilities/trigger phrases]
  (max 1024 chars, must include actual use case triggers)
allowed-tools: Bash(tool-name *)
disable-model-invocation: true   # Optional, for destructive ops
context: fork                     # Optional, isolated subagent
---

# Instructions here
Use `tool-name <subcommand> --flag` for X.
For complete flag reference, see [reference.md](reference.md)
```

---

## Skills vs MCP -- When to Use Which

### Decision tree

| Need | Use | Why |
|------|-----|-----|
| Claude uses a local binary | **Skill** with `allowed-tools: Bash(binary *)` | Binary rejects bad flags |
| Live data from an API with auth | **MCP** | Handles auth/token lifecycle |
| CLI tool with complex flag surface | **Skill** + `reference.md` | On-demand token loading |
| Destructive CLI ops (deploy, delete) | **Skill** + `disable-model-invocation: true` | User-only invocation |
| CLI tool that updates frequently | **Skill** with `` !`tool --help` `` injection | Always-current docs |
| Both connectivity + methodology | **MCP** for access, **Skill** for how-to | Separation of concerns |

### Expert opinions

**Armin Ronacher** (Flask/Pallets author) -- [lucumr.pocoo.org/2025/12/13/skills-vs-mcp/](https://lucumr.pocoo.org/2025/12/13/skills-vs-mcp/)

> MCP descriptions land in an awkward middle ground -- "too long to eagerly load, too short to really tell the agent how to use it."

Ronacher advocates letting agents write and maintain their own tool wrappers rather than embedding exhaustive docs in skills. The agent can then adapt both code and usage patterns simultaneously when problems arise. His core argument: **protocol stability matters more than elegant abstraction** for production tool integration.

Key finding: MCP servers require ~8K tokens upfront when eagerly loaded, offer minimal tool descriptions to conserve tokens, and lack API stability since servers frequently change interfaces.

**David Cramer** (Sentry eng) -- [cra.mr/mcp-skills-and-agents/](https://cra.mr/mcp-skills-and-agents/)

> "Use skills for local CLI behaviors; reserve MCP for network services requiring authentication and permission management."

Cramer warns against context pollution: "Both skills and MCP -- when used incorrectly -- will cause context pollution in your harness." MCP becomes problematic when servers expose excessive tools without optimization, creating unnecessary token consumption and recall issues.

He points to [Sentry's internal skills repository](https://github.com/getsentry/skills) as production examples, noting they're "pretty straightforward to build." Their `create-pr` skill wraps the `gh` CLI with specific formatting conventions.

**alexop.dev** -- [alexop.dev/posts/understanding-claude-code-full-stack/](https://alexop.dev/posts/understanding-claude-code-full-stack/)

Skills provide "automatic, context-driven behaviors" that activate when relevant. MCP servers expose tools but consume significant context. The recommendation: create skills with `description` fields matching CLI-related tasks, `allowed-tools` declarations for Bash access, and frontmatter documenting flags, subcommands, and common patterns.

---

## Anti-Hallucination Strategies

Three distinct strategies have emerged from the community:

### Strategy A: Scope with `allowed-tools`

Source: [alexop.dev](https://alexop.dev/posts/understanding-claude-code-full-stack/)

Constrain execution to the actual binary:

```yaml
allowed-tools: Bash(bun run xero-cli *)
```

If Claude invents a flag, the binary itself rejects it. Pairs with error handling instructions in the skill body that tell Claude what to do when a command fails.

### Strategy B: Wrap-and-simplify

Source: [blog.sshh.io/p/how-i-use-every-claude-code-feature](https://blog.sshh.io/p/how-i-use-every-claude-code-feature)

Rather than documenting a complex CLI in the skill, write a thin bash wrapper with a clean API and document that instead:

> "If your CLI commands are complex and verbose, don't write paragraphs of documentation to explain them...write a simple bash wrapper with a clear, intuitive API and document that. It's a fantastic forcing function for simplifying your codebase."

This approach prevents hallucination by:
- **Simplifying the interface** rather than documenting complexity
- **Creating intuitive wrappers** that hide flags/subcommands from the agent
- **Forcing API clarity** as a design-time benefit
- **Making the wrapper the source of truth**, not markdown docs

### Strategy C: Supporting file with on-demand loading

Source: [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)

Put exhaustive flag docs in `reference.md`. The SKILL.md body says:

```markdown
For complex usage or if you encounter an error, see [reference.md](reference.md)
```

Claude reads it when it needs it. This avoids burning tokens on docs the model may not need, and makes updating easy -- you edit one file, not a long prose instruction.

### Combined recommendation

Use all three together:
1. `allowed-tools` scoping as the hard guard
2. Simplify the CLI surface where possible
3. Split detailed docs into reference files for on-demand loading

---

## Dynamic Context Injection

Source: [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)

A critical feature for keeping docs current without manual maintenance:

```yaml
---
name: xero-reconcile
allowed-tools: Bash(bun run xero-cli *)
---
- CLI help: !`bun run xero-cli help`
- Auth status: !`bun run xero-cli status --json`
```

The `` !`command` `` syntax pre-executes shell commands and injects real output **before Claude sees anything**. For CLI tools, you can use this to pull live `--help` output or current config state at invocation time, eliminating staleness entirely.

### Trade-offs

| Pro | Con |
|-----|-----|
| Always accurate | Adds latency at invocation |
| Zero maintenance | Output format varies |
| Self-documenting | `--help` output can be noisy |

**Best for:** Fast-moving tools where flags change between versions.

**Alternative for stable tools:** Static `reference.md` (no execution overhead, predictable token count).

---

## Frontmatter Controls

Source: [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)

### Invocation control

| Frontmatter | You can invoke | Claude can invoke |
|---|---|---|
| (default) | Yes | Yes |
| `disable-model-invocation: true` | Yes | No |
| `user-invocable: false` | No | Yes |

**For CLI tools with side effects** (deploy, send, delete, reconcile): always set `disable-model-invocation: true`.

### `allowed-tools` scoped to specific binaries

```yaml
allowed-tools: Bash(gh *), Bash(docker *), Bash(kubectl *)
```

The Bash scope pattern (`toolname *`) forces Claude to use the real binary. It can't invent a flag and have it silently succeed.

### Context isolation

```yaml
context: fork
```

Runs the skill in an isolated subagent with its own context window. Prevents history from previous conversations bleeding into the skill's execution. Useful for reconciliation workflows that need a clean state.

### Character budget

Descriptions are loaded into context at all times (~2% of context window). Full skill content only loads on invocation. This is why the `reference.md` split matters -- you're not burning tokens on flag docs until the skill is actually called.

---

## Real-World Examples

### Sentry `create-pr` skill

Source: [github.com/getsentry/skills](https://github.com/getsentry/skills)

Wraps the `gh` CLI. Encodes PR formatting conventions and push behavior. Referenced by Sentry eng (cra.mr) as the canonical example of a "CLI methodology skill."

The repo contains 14 skills including code-review, commit conventions, security-review, and PR iteration. Template pattern:

```yaml
---
name: skill-name
description: Clear description with trigger keywords
---

# Skill Title
## Instructions
## Examples
## Guidelines
```

Skills declare `allowed-tools: Read, Grep, Glob` in frontmatter, suggesting CLI knowledge is declared via metadata rather than embedded inline.

### read-only-postgres skill

Source: [github.com/jawwadfirdousi](https://github.com/hesreallyhim/awesome-claude-code) (via awesome-claude-code)

Wraps `psql`. Adds safety:
- Validates SELECT-only queries
- Enforces row limits
- Adds timeouts
- Shows the safety-layer pattern for destructive-capable tools

### Codex CLI skill

Source: [github.com/klaudworks](https://github.com/hesreallyhim/awesome-claude-code) (via awesome-claude-code)

Wraps the `codex` CLI binary. Infers model, reasoning effort, and sandboxing parameters from natural language. Demonstrates the **parameter inference** pattern -- abstracting flag selection away from the user.

### Self-improvement loop skill

Source: [reddit.com/r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1r89084/selfimprovement_loop_my_favorite_claude_code_skill/) (256 pts, 48 comments)

Not CLI-specific, but demonstrates the `user-invocable: false` pattern: background knowledge that Claude consults but users don't manually invoke. Runs end-of-session, audits Claude's own friction, and updates CLAUDE.md with lessons learned.

---

## Community Patterns and Discussion

### Reddit (r/ClaudeCode + r/ClaudeAI, last 60 days)

**"Self-improvement Loop: My favorite Claude Code Skill"** -- 256 pts, 48 comments
- A "wrap-up" skill that runs end-of-session, audits Claude's own friction, and updates CLAUDE.md with lessons
- Community validated: commenters independently arrived at the same "memory directive" pattern
- Top comment: "lean into the built-in memory features released recently"
- [Thread link](https://www.reddit.com/r/ClaudeCode/comments/1r89084/selfimprovement_loop_my_favorite_claude_code_skill/)

**"We 3x'd our team's Claude Code skill usage in 2 weeks"** -- 45 pts, 16 comments
- Team surfaced skills via pre-tool-use hooks as a reliability mechanism
- Comment: "industry is converging to pre tool use hooks for steering agents"
- Skepticism surfaced about whether usage count is the right metric vs productivity outcomes
- [Thread link](https://www.reddit.com/r/ClaudeCode/comments/1rbr5t7/we_3xd_our_teams_claude_code_skill_usage_in_2/)

**"Claude Code Toolkit -- agents, skills, and rules for any project"** -- 5 pts, 5 comments
- Toolkit installs specialized agents (`/ralph` etc.)
- Explicit note: fully autonomous runs produce more bugs -- keeping users in the loop is the design
- [Thread link](https://www.reddit.com/r/ClaudeAI/comments/1r68pb1/claude_code_toolkit_agents_skills_and_rules_for/)

**"30+ skills collection for Claude Code"** -- 38 pts, 5 comments
- Large aggregation across dev, planning, docs, architecture
- Community feedback: "without verified examples it's hard to adopt them all at once" -- screencasts needed
- [Thread link](https://www.reddit.com/r/ClaudeAI/comments/1qjaq92/30_skills_collection_for_claude_code_dev_planning/)

**"I made 9 skills for Claude Code"** -- 11 pts, 11 comments
- Multi-domain skill set (domain hunting, logo creation, SEO)
- Community tip: an MCP could slot in alongside the skill rather than replacing it
- [Thread link](https://www.reddit.com/r/ClaudeAI/comments/1qknkqd/i_made_9_skills_for_claude_code_domain_hunting/)

**"Claude Code skills are underrated -- full sales team"** -- 37 pts, 50 comments
- [Thread link](https://www.reddit.com/r/ClaudeAI/comments/1q6ylnk/claude_code_skills_are_underrated_i_built_a_full/)

### YouTube tutorials

| Video | Creator | Views | Likes |
|-------|---------|-------|-------|
| [Claude Skills Explained: 4 Skills to 10x Your Coding Workflow](https://www.youtube.com/watch?v=bFC1QGEQ2E8) | Eric Tech | 57K | 1.45K |
| [Claude Code Skills & skills.sh - Crash Course](https://www.youtube.com/watch?v=rcRS8-7OgBo) | Alejandro AO | 48K | 1.2K |
| [Self-Improving Skills in Claude Code](https://www.youtube.com/watch?v=-4nUCaMNBR8) | Developers Digest | 46K | 1.4K |
| [Claude Code Skills - The Only Tutorial You Need](https://www.youtube.com/watch?v=vIUJ4Hd7be0) | Leon van Zyl | 25K | 708 |

---

## Local Codebase Findings

### Existing infrastructure

| Item | Location | Status |
|------|----------|--------|
| Skill directory | `.claude/skills/xero-reconcile/` | Created, SKILL.md not written |
| Todo item | `todos/043-active-xero-cli-agent-native-mvp.md` (item #20) | Pending |
| Plan reference | `docs/plans/2026-02-26-feat-xero-cli-agent-native-plan.md` (line ~2559) | Specifies requirements |
| Patterns skill | `~/code/claude-code-config/skills/patterns/SKILL.md` | Canonical reference |

### Key reference implementations

**Patterns skill** (`~/code/claude-code-config/skills/patterns/SKILL.md`)
- Canonical reference for CLI-wrapping skills
- Covers tri-modal output (JSON/JSONL/human-readable), typed exit codes, structured error contracts
- Field projection (`--fields` flag), agent mode detection (non-TTY, headless)
- References `@side-quest/observability` CLI as the reference implementation

**Agent-native architecture skill** (compound plugin)
- 5 core principles: Parity, Granularity, Composability, Emergent Capability, Improvement Over Time
- 13 routing topics with reference files
- Architecture checklist and anti-patterns

**File-todos skill** (compound plugin)
- Good model for structured workflow skills
- Naming conventions, YAML frontmatter, structured sections
- Integration patterns: code review to findings to triage to todos

### Plan requirements for xero-reconcile

From `docs/plans/2026-02-26-feat-xero-cli-agent-native-plan.md`:

- **Full runbook, not a template** -- decision trees, failure recovery, specific rules
- **Contract-first** -- JSON schemas drafted during Phase 2, committed as `docs/xero-cli-contract.md`
- **CLI resolution** -- uses `bun run xero-cli` (not hardcoded paths)
- **Cross-command auth recovery** -- documented so Claude doesn't restart from scratch
- **BankTransactionID immutability** -- never reconstruct from display fields
- **Invoice amount/currency derivation logic**
- **Contact name normalization heuristics**
- **MUST be built with the Skill Creator skill**

### Build tools available

| Command | Purpose |
|---------|---------|
| `/claude-code:build-skill` | Scaffold directory structure |
| `/claude-code:write-skill` | Write SKILL.md using best practices |
| `/claude-code:test-skill` | Validate triggering |
| `/claude-code:debug-skill` | Fix undertriggering/overtriggering |
| `/claude-code:validate-skill` | Final quality gates |

---

## Recommendations for xero-reconcile

Based on all findings, here is the recommended approach:

### Directory structure

```
.claude/skills/xero-reconcile/
+-- SKILL.md                       # Runbook (<500 lines, <5000 tokens)
+-- references/
    +-- cli-contract.md            # JSON schemas for all xero-cli outputs
    +-- decision-trees.md          # Transaction categorization logic
    +-- error-recovery.md          # Auth/reconcile failure handling
    +-- examples.md                # Real workflow examples
```

### Frontmatter

```yaml
---
name: xero-reconcile
description: >
  Reconcile Xero bank transactions. Use when asked to categorize,
  match, or reconcile transactions from Xero. Handles auth recovery,
  transaction fetching, account matching, and reconciliation execution.
disable-model-invocation: true
allowed-tools: Bash(bun run xero-cli *)
context: fork
---
```

### Key design decisions

1. **`disable-model-invocation: true`** -- reconciliation has side effects (writes to Xero API)
2. **`allowed-tools: Bash(bun run xero-cli *)`** -- hard guard against hallucinated flags
3. **`context: fork`** -- isolated subagent, clean state for each reconciliation
4. **Dynamic injection** for live auth state: `` !`bun run xero-cli status --json` ``
5. **Reference files** for detailed CLI contract, decision trees, error recovery
6. **Build with Skill Creator** as specified in the plan

### SKILL.md sections needed

1. Overview + when to use
2. Prerequisites (auth check, data fetch)
3. Step-by-step workflow (analyze, categorize, propose, review, execute)
4. Error handling (auth failure, timeout, mid-reconcile failure)
5. Idempotency/resume rules
6. BankTransactionID immutability rules
7. Links to reference files

---

## Sources

### Official Documentation

- [Extend Claude with Skills -- Official Docs](https://code.claude.com/docs/en/skills)

### Expert Blog Posts

- [Skills vs MCP -- Armin Ronacher](https://lucumr.pocoo.org/2025/12/13/skills-vs-mcp/)
- [MCP, Skills, and Agents -- David Cramer (cra.mr)](https://cra.mr/mcp-skills-and-agents/)
- [Understanding Claude Code Full Stack -- alexop.dev](https://alexop.dev/posts/understanding-claude-code-full-stack/)
- [How I Use Every Claude Code Feature -- blog.sshh.io](https://blog.sshh.io/p/how-i-use-every-claude-code-feature)

### GitHub Repositories

- [Sentry Skills Repository](https://github.com/getsentry/skills)
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)

### Reddit Threads

- [Self-improvement Loop: My favorite Claude Code Skill](https://www.reddit.com/r/ClaudeCode/comments/1r89084/selfimprovement_loop_my_favorite_claude_code_skill/) (256 pts, 48 comments)
- [We 3x'd our team's Claude Code skill usage in 2 weeks](https://www.reddit.com/r/ClaudeCode/comments/1rbr5t7/we_3xd_our_teams_claude_code_skill_usage_in_2/) (45 pts, 16 comments)
- [Claude Code Toolkit -- agents, skills, and rules](https://www.reddit.com/r/ClaudeAI/comments/1r68pb1/claude_code_toolkit_agents_skills_and_rules_for/) (5 pts, 5 comments)
- [30+ skills collection for Claude Code](https://www.reddit.com/r/ClaudeAI/comments/1qjaq92/30_skills_collection_for_claude_code_dev_planning/) (38 pts, 5 comments)
- [I made 9 skills for Claude Code](https://www.reddit.com/r/ClaudeAI/comments/1qknkqd/i_made_9_skills_for_claude_code_domain_hunting/) (11 pts, 11 comments)
- [Claude Code skills are underrated](https://www.reddit.com/r/ClaudeAI/comments/1q6ylnk/claude_code_skills_are_underrated_i_built_a_full/) (37 pts, 50 comments)

### YouTube Tutorials

- [Claude Skills Explained: 4 Skills to 10x Your Coding Workflow](https://www.youtube.com/watch?v=bFC1QGEQ2E8) -- Eric Tech (57K views)
- [Claude Code Skills & skills.sh - Crash Course](https://www.youtube.com/watch?v=rcRS8-7OgBo) -- Alejandro AO (48K views)
- [Self-Improving Skills in Claude Code](https://www.youtube.com/watch?v=-4nUCaMNBR8) -- Developers Digest (46K views)
- [Claude Code Skills - The Only Tutorial You Need](https://www.youtube.com/watch?v=vIUJ4Hd7be0) -- Leon van Zyl (25K views)

### Local Reference Files

- `~/code/claude-code-config/skills/patterns/SKILL.md` -- Canonical CLI patterns skill
- `docs/plans/2026-02-26-feat-xero-cli-agent-native-plan.md` -- Plan with skill requirements
- `.claude/skills/xero-reconcile/` -- Target skill directory (empty)
