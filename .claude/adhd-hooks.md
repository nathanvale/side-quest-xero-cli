# ADHD Hooks (User Scope)

These hooks are installed at user scope so they apply across repos.

## Installed Files

- `~/.claude/hooks/adhd/adhd-coach.py`
- `~/.claude/settings.json` (`hooks` section)
- `~/.claude/adhd-hooks-state.json` (runtime state)

## Behaviors Enabled

1. `SessionStart`: injects mission/focus protocol context
2. `UserPromptSubmit`: single-thread guard + mission controls
3. `PreToolUse (Bash)`: blocks destructive commands
4. `PostToolUse (Edit|Write)`: momentum pings + progress state
5. `PostToolUseFailure`: recovery coaching context
6. `Notification`: attention nudges for permission/idle prompts
7. `SubagentStart`: overload warning when too many subagents
8. `SubagentStop`: subagent counter decrement
9. `Stop`: requires mission closeout before stopping
10. `PreCompact`: preserve active mission through compaction
11. `ConfigChange`: config-change awareness context

## Prompt Controls

- `MISSION` (bare) shows numbered mission options to pick from
- `MISSION: <goal>` sets/updates active mission directly
- `focus: low|normal|deep` sets focus level
- `SWITCH_MISSION` allows deliberate cross-repo mission switch
- `PAUSE_MISSION` pauses mission
- `COMPLETE_MISSION` clears mission
- `ADHD_OFF` disables ADHD hook nudges/blocks globally
- `ADHD_NUDGE` (or `ADHD_ON`) enables reminder mode (default)
- `ADHD_STRICT` enables stronger blocking guardrails
- `ADHD_STATUS` shows current mode + active mission
- `ADHD_BYPASS` bypasses cross-repo nudge/block once

Control-token safety:
- Control tokens are treated as directives only when they appear at the start of a prompt line (prevents accidental toggles in quoted text/snippets).
- Lines inside fenced code blocks (``` ... ```) are ignored for control-token directives.

Authentication recovery is always fail-open:
- Prompts that clearly look like Xero auth recovery (`xero`, `api-explorer`, `tenant`, `xero login`, `xero oauth`) bypass cross-repo guard so login/re-auth never gets trapped.

State resilience:
- Hook state writes are atomic and file mode is private (`0600`).
- If state JSON becomes corrupt, the hook backs it up to `~/.claude/adhd-hooks-state.json.corrupt-*` and recovers fail-open.
- Missions stale for more than 24 hours are auto-cleared on next hook run.

## Per-repo Opt-out

Create `.claude/adhd-hooks.json` in a repo:

```json
{
  "enabled": false
}
```

Or keep enabled but force nudge mode:

```json
{
  "enabled": true,
  "mode": "nudge"
}
```

Valid `mode`: `off`, `nudge`, `strict`.

## Rollback

If needed, restore from your latest backup:

```bash
ls -1t ~/.claude/settings.json.bak-adhd-hooks-* | head -n 1
# then:
cp <backup-file> ~/.claude/settings.json
```

## Operational Notes

- Hook configuration is loaded at session start. If you edit `~/.claude/settings.json`, restart Claude Code for changes to take effect.
- Keep `skipDangerousModePermissionPrompt` disabled for safer defaults.
