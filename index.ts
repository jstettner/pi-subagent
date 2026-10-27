import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import { getPane, HERDR_METADATA_SOURCE, herdrAgentName, herdrBin, tryHerdr } from "./herdr.ts";
import { rexBin, tryRex } from "./rex.ts";
import {
	effectiveRunState,
	getRunsDir,
	inboxDir,
	killRun,
	launchRun,
	listRuns,
	readMetadata,
	removeRunDir,
	runDisplayName,
	type InboxMessage,
	type RunMetadata,
	resolveHerdrPane,
	runBackend,
	runIsAlive,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

/**
 * Herdr resumes pi panes after a server restart with only `pi --session <file>`, dropping the run directory
 * environment. Recognize a run's session file so the resumed process still acts as that subagent.
 */
function runDirFromSessionArg(): string | undefined {
	const index = process.argv.indexOf("--session");
	const sessionFile = index >= 0 ? process.argv[index + 1] : undefined;
	if (!sessionFile || basename(sessionFile) !== "session.jsonl") return undefined;
	const candidate = dirname(sessionFile);
	if (dirname(candidate) !== getRunsDir()) return undefined;
	return readMetadata(candidate)?.sessionFile === sessionFile ? candidate : undefined;
}

function displayState(metadata: RunMetadata): string {
	return effectiveRunState(metadata).padEnd(8);
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR || runDirFromSessionArg();
	// Keep nested spawns disabled for tools run by a child that herdr resumed without the environment.
	if (runDir) process.env.PI_SUBAGENT_RUN_DIR = runDir;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
	}

	pi.registerCommand("subagent", {
		description: "Select and attach to a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) => effectiveRunState(run) !== "exited");
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}

			const items: SelectItem[] = runs.map((run) => ({
				value: run.handle,
				label: `${runDisplayName(run)}  ${displayState(run)}  ${run.provider}/${run.model}  ${run.thinking}`,
			}));
			let tui: TUI | undefined;
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				tui = customTui;
				const list = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);

				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Attach to subagent")), 1, 0));
				container.addChild(list);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`${keyHint("tui.select.confirm", "attach")}  ${keyHint("tui.select.cancel", "cancel")}`,
						),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						list.handleInput(data);
						customTui.requestRender();
					},
				};
			});
			if (!selected || !tui) return;
			const run = runs.find((candidate) => candidate.handle === selected);
			if (!run) return;

			if (runBackend(run) === "herdr") {
				const paneId = resolveHerdrPane(run);
				const tabId = paneId ? getPane(paneId)?.tab_id : undefined;
				const focused =
					paneId !== undefined &&
					(tryHerdr(["agent", "focus", paneId]) !== undefined ||
						(tabId !== undefined && tryHerdr(["tab", "focus", tabId]) !== undefined));
				if (!focused) ctx.ui.notify(`Could not focus ${run.handle}`, "error");
				return;
			}
			if (runBackend(run) === "rex") {
				const placement = run.rex;
				const focused =
					placement?.blockId !== undefined &&
					tryRex(["focus", "-s", placement.sessionId, placement.blockId]) !== undefined;
				if (!focused) ctx.ui.notify(`Could not focus ${run.handle}`, "error");
				return;
			}
			const tmuxSession = run.tmuxSession;
			if (!tmuxSession) return;

			if (process.env.TMUX) {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["switch-client", "-t", tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
				return;
			}

			tui.stop();
			try {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["attach-session", "-t", tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;

		const refreshWidget = (): void => {
			if (!widgetContext) return;
			const activeRuns = listRuns(widgetContext.sessionManager.getSessionId())
				.map((run) => ({ run, state: effectiveRunState(run) }))
				.filter(({ state }) => state !== "exited");
			if (activeRuns.length === 0) {
				widgetContext.ui.setWidget("subagents", undefined);
				return;
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy" ? "warning" : state === "idle" ? "success" : state === "error" ? "error" : "muted";
				return widgetContext!.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`);
			});
			if (activeRuns.length > visible.length) {
				visible.push(widgetContext.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`));
			}
			widgetContext.ui.setWidget(
				"subagents",
				[widgetContext.ui.theme.fg("dim", "subagents: ") + visible.join(widgetContext.ui.theme.fg("dim", " | "))],
				{ placement: "belowEditor" },
			);
		};

		pi.on("session_start", (_event, ctx) => {
			// Relaunch children that were suspended when this session was last quit or switched away from.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.suspended || runIsAlive(run)) continue;
				if (!existsSync(run.sessionFile)) {
					removeRunDir(run.runDir);
					continue;
				}
				const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
				try {
					launchRun(starting);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { state: "error", error: message });
					if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
				}
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
			refreshWidget();
			widgetTimer = setInterval(refreshWidget, 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload") return;
			// Suspend running children: stop the process but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!runIsAlive(run)) {
					if (!run.suspended) removeRunDir(run.runDir);
					continue;
				}
				updateMetadata(run.runDir, { suspended: true });
				killRun(run);
				await waitForRunShutdown(run.runDir);
			}
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;
	const herdrPaneId = process.env.HERDR_ENV === "1" ? process.env.HERDR_PANE_ID : undefined;
	let herdrLabel: string | undefined;
	let herdrAgentLabel: string | undefined;
	let herdrPending = false;
	let yielded = false;
	const rexBlockId = process.env.REX_BLOCK;
	let rexLabel: string | undefined;
	let rexPending = false;

	const runHerdr = (args: string[]): Promise<boolean> =>
		new Promise((resolveRun) => execFile(herdrBin(), args, (error) => resolveRun(!error)));

	/** Show the subagent nested under its parent in the herdr sidebar; see README for the matching row layout. */
	const syncHerdrLabels = async (metadata: RunMetadata): Promise<void> => {
		if (!herdrPaneId || herdrPending) return;
		const label = metadata.name ?? metadata.handle;
		const agentName = herdrAgentName(metadata.handle, metadata.name);
		if (label === herdrLabel && agentName === herdrAgentLabel) return;
		herdrPending = true;
		try {
			if (label !== herdrLabel) {
				const reported = await runHerdr([
					"pane",
					"report-metadata",
					herdrPaneId,
					"--source",
					HERDR_METADATA_SOURCE,
					"--display-agent",
					`↳ ${label}`,
					"--token",
					`subagent=${label}`,
				]);
				if (reported) {
					herdrLabel = label;
					void runHerdr(["pane", "rename", herdrPaneId, label]);
				}
			}
			// Naming requires herdr to have detected pi in the pane, so this retries until it succeeds.
			if (agentName !== herdrAgentLabel && (await runHerdr(["agent", "rename", herdrPaneId, agentName]))) {
				herdrAgentLabel = agentName;
			}
		} finally {
			herdrPending = false;
		}
	};

	/** Keep the rex block label in step with `subagent rename`. */
	const syncRexLabel = (metadata: RunMetadata): void => {
		const sessionId = metadata.rex?.sessionId;
		if (runBackend(metadata) !== "rex" || !sessionId || !rexBlockId || rexPending) return;
		const label = metadata.name ?? metadata.handle;
		if (label === rexLabel) return;
		rexPending = true;
		execFile(rexBin(), ["block", "rename", "-s", sessionId, rexBlockId, label], (error) => {
			rexPending = false;
			if (!error) rexLabel = label;
		});
	};

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		void syncHerdrLabels(metadata);
		syncRexLabel(metadata);
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	/**
	 * Claim the run for this herdr pane. A herdr restore and the parent's relaunch can both start the child;
	 * the later process yields so only one pi writes the session. Returns false when this process must exit.
	 */
	const claimHerdrPane = (metadata: RunMetadata): boolean => {
		if (!herdrPaneId || runBackend(metadata) !== "herdr") return true;
		const owner = metadata.herdr?.paneId;
		if (owner && owner !== herdrPaneId) {
			const pane = getPane(owner);
			if (pane?.agent === "pi" && pane.agent_session?.value === metadata.sessionFile) return false;
		}
		const pane = getPane(herdrPaneId);
		updateMetadata(runDir, {
			herdr: {
				...metadata.herdr,
				paneId: herdrPaneId,
				tabId: pane?.tab_id ?? metadata.herdr?.tabId,
				workspaceId: pane?.workspace_id ?? metadata.herdr?.workspaceId,
			},
		});
		return true;
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateMetadata(runDir, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}

				updateMetadata(runDir, { state: "busy", error: undefined });
				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch (error) {
					updateMetadata(runDir, {
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		if (!claimHerdrPane(metadata)) {
			yielded = true;
			currentContext = undefined;
			ctx.shutdown();
			return;
		}
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
		});
		syncSessionName();
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle" });
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit" && !yielded) updateMetadata(runDir, { state: "exited" });
	});
}
