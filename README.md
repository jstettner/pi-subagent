# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own terminal (a herdr pane, a Rex block, or a tmux session) with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or attach directly to the child TUI.

## Requirements

- Pi
- Node.js 22.19 or newer
- [herdr](https://herdr.dev), [Rex](https://www.superlogical.com/rex), or tmux

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

When the parent Pi runs inside herdr (`HERDR_ENV=1`), subagents open as herdr panes. Otherwise, inside a Rex terminal (`REX_SESSION` and `REX_BLOCK` set), they open as Rex blocks. Anywhere else they use detached tmux sessions. Set `PI_SUBAGENT_BACKEND` to `herdr`, `rex`, or `tmux` to force one.

With herdr:

- Children of one parent session share a `subagents` tab in the parent's workspace, split side by side, so they can be watched without attaching. The tab closes when its last child stops.
- Herdr's Pi integration reports each child's `working`, `idle`, `done`, or `blocked` state in the sidebar.
- Each child shows as `↳ <name>` in the sidebar and gets a herdr agent name of `<name-slug>-<handle>`, usable with `herdr agent read` and similar commands. Keep using `subagent send` for prompts.
- `/subagent` focuses the child's pane.
- `--worktree <branch>` runs the child in a herdr-managed git worktree, opened as its own workspace grouped under the repository's workspace. An existing checkout of that branch is reused. `subagent stop` closes the workspace but keeps the checkout; remove it with `herdr worktree remove`.
- Moved panes are followed by their Pi session file. If herdr restarts and resumes a child, the resumed process takes over the run, and a duplicate launched by the parent exits.

With Rex:

- The first child opens below the parent's pane without taking focus. Additional children split side by side within that lower area. Stopping the last child restores the parent's space; no separate tab is opened. The CLI requests 35% height for the lower area, though Rex versions that ignore `--ratio` use 50%.
- Each child's block is labeled with its name, and `subagent rename` updates the label.
- `/subagent` focuses the child's block; `subagent status` prints the matching `rex focus` command.
- `--worktree` is not supported; it needs herdr.

To render herdr children nested under their parent in the agents sidebar, add this to `~/.config/herdr/config.toml`:

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
- `--no-extensions`: disable extension discovery while retaining the control bridge, plus any extensions listed in `~/.pi/agent/subagent-extensions` (one path per line; `~` is the home directory, relative paths start from `~/.pi/agent`, and `#` starts a comment). Use it for guards every agent should keep.
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history. `subagent stop` removes a run permanently.

## Serial mode

A local server with one cache slot, such as Ollama with `OLLAMA_NUM_PARALLEL=1`, keeps only one conversation's prefix warm. Agents that interleave their model calls evict each other and re-prefill their whole context on every call. llama-server with `-np N` keeps N, and more agents than slots thrash the same way. `/serial` toggles serial mode: Pi sessions on a local provider then take turns on the model, through one of that provider's machine-wide locks, which each takes before its first model call. `ollama` has one lock. `llama-local` (llama-server `-np 8`) has eight, one of them reserved for parents: subagents share seven, and a parent takes the eighth without waiting in line, so it never waits for a child's whole task to end. Each provider has its own line (`LANES` in `serial.ts`), and so does a model listed there by itself as `provider/model` (Ollama's `:tag` dropped): Ollama's MLX engine gives each model its own runner and slots. `ollama/inkling-2-mini` has eight, one reserved for parents, to match `OLLAMA_NUM_PARALLEL=8`; without it, Ollama picks the count from free memory (two, here). The footer shows `serial: waiting (#N in queue)` or `serial: running`. While a session waits, it also reports a `serial` record of `blocked` to the terminal (OSC 7501), so Rex shows it as held; the record clears once it takes a lock.

- A subagent holds the lock until its run settles, then the next in line, in arrival order, takes it.
- A parent goes ahead of every waiting subagent, behind only the current holder, so its own work keeps a warm cache. It lets go when its run settles or when it blocks on a tool (a `subagent wait`, or any tool still running after 20 seconds), so its children run while it waits on them.

The setting is a file (`~/.pi/agent/serial-subagents/enabled`), so running sessions pick it up too, and it survives restarts. Children keep it under `--no-extensions`. While it's on, `subagent wait` has no default deadline, since a child may wait in line behind every other agent's whole task; an explicit `--timeout` still applies.
