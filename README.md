# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own terminal (a herdr pane or a tmux session) with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or attach directly to the child TUI.

## Requirements

- Pi
- Node.js 22.19 or newer
- [herdr](https://herdr.dev) or tmux

## Install

Clone into Pi's global extension directory and expose the CLI on `PATH`:

```sh
git clone git@github.com:earendil-works/pi-subagent.git ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
```

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

Use `/subagent` to select and attach to an active child. The status widget shows active names (or handles for unnamed runs) and their current state.

## Terminal backends

When the parent Pi runs inside herdr (`HERDR_ENV=1`), subagents open as herdr panes; otherwise they use detached tmux sessions. Set `PI_SUBAGENT_BACKEND=tmux` or `PI_SUBAGENT_BACKEND=herdr` to force one.

With herdr:

- Children of one parent session share a `subagents` tab in the parent's workspace, split side by side, so they can be watched without attaching. The tab closes when its last child stops.
- Herdr's Pi integration reports each child's `working`, `idle`, `done`, or `blocked` state in the sidebar.
- Each child shows as `↳ <name>` in the sidebar and gets a herdr agent name of `<name-slug>-<handle>`, usable with `herdr agent read` and similar commands. Keep using `subagent send` for prompts.
- `/subagent` focuses the child's pane.
- `--worktree <branch>` runs the child in a herdr-managed git worktree, opened as its own workspace grouped under the repository's workspace. An existing checkout of that branch is reused. `subagent stop` closes the workspace but keeps the checkout; remove it with `herdr worktree remove`.
- Moved panes are followed by their Pi session file. If herdr restarts and resumes a child, the resumed process takes over the run, and a duplicate launched by the parent exits.

To render children nested under their parent in the agents sidebar, add this to `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", { token = "tab", rules = [{ equals = "subagents", hide = true }] }],
  [{ token = "agent", rules = [{ starts_with = "↳", dim = true }] }],
]
```

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history. `subagent stop` removes a run permanently.
