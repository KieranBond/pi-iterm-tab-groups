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
/tab-group enable
/tab-group disable
```

`join` creates a locked manual assignment. `leave` locks the tab in an ungrouped state. `auto` removes the lock.

## Deterministic grouping

The first release uses these signals, in order:

1. Manual lock
2. Parent Pi session or shared subagent run
3. Exact ticket ID such as `ABC-123`
4. Last assignment
5. Unassigned

Repository identity travels as a weak hint but does not group tabs by itself. Two sessions in one repository can work on unrelated tasks.

Semantic grouping will arrive in a later release after the deterministic workflow passes multi-tab testing.

## Terminal behavior

The extension emits iTerm2's `OSC 1337;SetColors=tab=RRGGBB` sequence. It derives the colour from an immutable group ID and sanitizes the group label before setting the title.

The extension does nothing outside Pi's TUI or iTerm2. It also disables terminal changes inside tmux by default. To force tmux passthrough attempts:

```bash
export PI_ITERM_TAB_GROUPS_FORCE_TMUX=1
```

Normal shutdown resets the tab colour. A forced process kill can leave the colour in place until Pi starts again.

## Privacy

Context cards contain bounded metadata only: session ID/name, branch, hashed Git remote, ticket IDs, parent IDs, and manual state. They never contain prompts, assistant output, tool output, or file content.

## Development

```bash
npm install
npm test
npm run typecheck
npm pack --dry-run
```
