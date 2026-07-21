# pi-iterm-tab-groups

Give related Pi sessions the same iTerm2 tab colour, including sessions in different repositories.

This package uses pi-intercom's silent extension channel. Grouping metadata never enters the Pi transcript and never starts an agent turn.

## Requirements

- Pi with `@earendil-works/pi-coding-agent`
- `pi-intercom` with `extension-bus-v1` support
- iTerm2
- Direct Pi sessions rather than tmux, unless forced

## Install

```bash
pi install npm:pi-intercom
pi install npm:pi-iterm-tab-groups
```

Restart Pi after installation.

## Commands

```text
/tab-group status
/tab-group join <group>
/tab-group auto
/tab-group leave
/tab-group refresh
/tab-group refresh --all
/tab-group enable
/tab-group disable
```

`join` creates a locked manual assignment. `leave` locks the tab in an ungrouped state. `auto` removes the lock. `refresh --all` asks every enabled session to rebuild and republish its context card through the elected coordinator; unchanged semantic cards do not consume another model call.

## Grouping

Deterministic signals run first, in this order:

1. Manual lock
2. Parent Pi session or shared subagent run
3. Exact ticket ID such as `ABC-123`
4. Last assignment
5. Unassigned

Repository identity is only a weak hint. Two sessions in one repository can work on unrelated tasks.

Semantic grouping is optional and disabled by default. Enable it in `~/.pi/agent/iterm-tab-groups/config.json`:

```json
{
  "semantic": {
    "enabled": true,
    "provider": "anthropic",
    "model": "claude-haiku-4-5"
  }
}
```

The configured model is explicit: the extension never falls back to Pi's active model. Semantic calls run after `agent_settled` with a five-minute cooldown. Each session's synopsis pass and the elected coordinator's fleet classifier are each capped at six calls per hour by default. Manual locks, parent links, and exact ticket matches always take precedence.

## Terminal behavior

The extension emits iTerm2's `OSC 1337;SetColors=tab=RRGGBB` sequence. It derives the colour from an immutable group ID and sanitizes the group label before setting the title.

The extension does nothing outside Pi's TUI or iTerm2. It also disables terminal changes inside tmux by default. To force tmux passthrough attempts:

```bash
export PI_ITERM_TAB_GROUPS_FORCE_TMUX=1
```

Normal shutdown resets the tab colour. A forced process kill can leave the colour in place until Pi starts again.

## Privacy

Context cards contain bounded metadata: session ID/name, branch, hashed Git remote, ticket IDs, parent IDs, manual state, and—when semantics are enabled—a short generated synopsis with domain nouns. The intercom bus and broker state never receive or persist raw prompts, transcripts, assistant output, tool output, file content, or raw model responses. Generated synopsis text is bounded, screened for verbatim prompt reuse and common secret/path patterns, then shared with the other local sessions.

Synopsis generation sends only the three most recent direct user prompts, bounded to 6,000 characters total, to the configured provider. Classification receives synopsis cards and group metadata only. Semantic grouping stays off unless you enable it.

## Development

```bash
npm install
npm test
npm run typecheck
npm pack --dry-run
```

Run the live three-tab test from iTerm2 after installing the local packages:

```bash
npm run smoke:iterm
```

The test starts three temporary Pi sessions, verifies one coordinated assignment, and exits them with `/quit`. It deliberately never closes iTerm windows through AppleScript because doing so while a process is active can leave an off-screen confirmation sheet that blocks tab clicks and menu items.
