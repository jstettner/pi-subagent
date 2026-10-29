import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	findPaneBySession,
	getPane,
	HERDR_TAB_LABEL,
	herdr,
	insideHerdr,
	shellQuote,
	splitDirection,
	tryHerdr,
} from "./herdr.ts";
import { blockIsRunning, insideRex, rex, tryRex } from "./rex.ts";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export type RunBackend = "tmux" | "herdr" | "rex";

export interface HerdrPlacement {
	/** Pane currently hosting the child; updated when the pane is moved or restored. */
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
	/** Workspace of the spawning parent, where the shared subagents tab lives. */
	parentWorkspaceId?: string;
	/** Linked git worktree the child runs in, opened as its own herdr workspace. */
	worktree?: { branch: string; path?: string; repoCwd: string };
}

export interface RexPlacement {
	/** Rex session of the spawning parent; the child's block lives there. */
	sessionId: string;
	/** Parent block whose lower area hosts this run and its siblings. */
	parentBlockId?: string;
	blockId?: string;
	windowId?: string;
}

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	/** Absent on runs created before herdr support, which always used tmux. */
	backend?: RunBackend;
	tmuxSession?: string;
	herdr?: HerdrPlacement;
	rex?: RexPlacement;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			(metadata.backend === "herdr"
				? typeof metadata.herdr !== "object"
				: metadata.backend === "rex"
					? typeof metadata.rex?.sessionId !== "string"
					: typeof metadata.tmuxSession !== "string") ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function runBackend(metadata: RunMetadata): RunBackend {
	return metadata.backend ?? "tmux";
}

/** Prefer herdr panes inside herdr, then rex blocks inside rex; `PI_SUBAGENT_BACKEND` forces a backend. */
export function selectBackend(): RunBackend {
	const forced = process.env.PI_SUBAGENT_BACKEND;
	if (forced === "tmux" || forced === "herdr" || forced === "rex") return forced;
	if (insideHerdr()) return "herdr";
	return insideRex() ? "rex" : "tmux";
}

function tmuxSessionExists(session: string | undefined): boolean {
	return !!session && spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
}

/** Resolve the herdr pane hosting a run, following moves and herdr restores via the pi session file. */
export function resolveHerdrPane(metadata: RunMetadata): string | undefined {
	const paneId = metadata.herdr?.paneId;
	// Herdr keeps a moved pane's old ID as an alias, so a lookup can return a different canonical ID.
	const pane = (paneId ? getPane(paneId) : undefined) ?? findPaneBySession(metadata.sessionFile);
	if (!pane) return undefined;
	if (pane.pane_id === paneId) return paneId;
	updateMetadata(metadata.runDir, {
		herdr: { ...metadata.herdr, paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id },
	});
	return pane.pane_id;
}

export function runIsAlive(metadata: RunMetadata): boolean {
	switch (runBackend(metadata)) {
		case "herdr":
			return resolveHerdrPane(metadata) !== undefined;
		case "rex":
			return !!metadata.rex?.blockId && blockIsRunning(metadata.rex.sessionId, metadata.rex.blockId);
		case "tmux":
			return tmuxSessionExists(metadata.tmuxSession);
	}
}

/**
 * Terminate the child process. Herdr closes the pane, and the tab or worktree workspace once it is empty;
 * Rex closes only the child's block, leaving the parent's pane and window intact.
 */
export function killRun(metadata: RunMetadata): void {
	if (runBackend(metadata) === "herdr") {
		const paneId = resolveHerdrPane(metadata);
		if (paneId) tryHerdr(["pane", "close", paneId]);
		return;
	}
	if (runBackend(metadata) === "rex") {
		const placement = metadata.rex;
		if (placement?.blockId) tryRex(["block", "close", "-s", placement.sessionId, placement.blockId]);
		return;
	}
	if (metadata.tmuxSession) spawnSync("tmux", ["kill-session", "-t", metadata.tmuxSession], { stdio: "ignore" });
}

export function attachHint(metadata: RunMetadata): string {
	if (runBackend(metadata) === "herdr") {
		const paneId = readMetadata(metadata.runDir)?.herdr?.paneId ?? metadata.herdr?.paneId;
		return paneId ? `herdr agent focus ${paneId}` : "(herdr pane not started)";
	}
	if (runBackend(metadata) === "rex") {
		const placement = readMetadata(metadata.runDir)?.rex ?? metadata.rex;
		return placement?.blockId
			? `rex focus -s ${placement.sessionId} ${placement.blockId}`
			: "(rex block not started)";
	}
	return `tmux attach -t ${metadata.tmuxSession}`;
}

function piCommand(metadata: RunMetadata, initialArgs: string[]): string[] {
	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}
	return [
		"env",
		`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
		launcher,
		"--session",
		metadata.sessionFile,
		"--provider",
		metadata.provider,
		"--model",
		metadata.model,
		"--thinking",
		metadata.thinking,
		...(metadata.launchArgs ?? []),
		...initialArgs,
	];
}

/** Start the child pi process for a run. `initialArgs` are only passed on first spawn. */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): void {
	if (runBackend(metadata) === "herdr") {
		launchHerdrRun(metadata, initialArgs);
		return;
	}
	if (runBackend(metadata) === "rex") {
		launchRexRun(metadata, initialArgs);
		return;
	}
	if (!metadata.tmuxSession) throw new Error(`${metadata.handle} has no tmux session`);
	const result = spawnSync(
		"tmux",
		[
			"new-session",
			"-d",
			"-s",
			metadata.tmuxSession,
			"-x",
			"120",
			"-y",
			"40",
			"-c",
			metadata.cwd,
			"--",
			...piCommand(metadata, initialArgs),
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to create tmux session");
}

interface PaneResult {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
}

/** Open the run's worktree workspace, creating the checkout on first launch. Returns a fresh shell pane in it. */
function placeInWorktree(metadata: RunMetadata, worktree: NonNullable<HerdrPlacement["worktree"]>): PaneResult {
	if (!worktree.path) {
		// Reuse an existing checkout of the branch, e.g. one kept by an earlier stopped run.
		const existing = (
			herdr(["worktree", "list", "--cwd", worktree.repoCwd]).worktrees as { branch?: string; path: string }[]
		).find((candidate) => candidate.branch === worktree.branch || candidate.branch === `refs/heads/${worktree.branch}`);
		if (existing && existsSync(existing.path)) {
			worktree = { ...worktree, path: existing.path };
			updateMetadata(metadata.runDir, { cwd: existing.path, herdr: { ...metadata.herdr, worktree } });
			metadata.cwd = existing.path;
		}
	}
	if (worktree.path && existsSync(worktree.path)) {
		const opened = herdr([
			"worktree",
			"open",
			"--cwd",
			worktree.repoCwd,
			"--path",
			worktree.path,
			"--no-focus",
		]);
		const workspaceId = (opened.workspace as { workspace_id: string }).workspace_id;
		if (!opened.already_open) {
			const pane = (herdr(["pane", "list", "--workspace", workspaceId]).panes as PaneResult[])[0];
			if (pane) return pane;
		}
		const created = herdr(["tab", "create", "--workspace", workspaceId, "--cwd", worktree.path, "--no-focus"]);
		return created.root_pane as PaneResult;
	}
	const args = ["worktree", "create", "--cwd", worktree.repoCwd, "--branch", worktree.branch, "--no-focus"];
	if (metadata.name) args.push("--label", metadata.name);
	const created = herdr(args);
	const path = (created.worktree as { path: string }).path;
	updateMetadata(metadata.runDir, { cwd: path, herdr: { ...metadata.herdr, worktree: { ...worktree, path } } });
	metadata.cwd = path;
	return created.root_pane as PaneResult;
}

/** Split a live sibling's pane in the parent's subagents tab, or open that tab next to the parent. */
function placeInSubagentsTab(metadata: RunMetadata): PaneResult {
	const sibling = listRuns(metadata.parentSessionId)
		.filter(
			(run) =>
				run.handle !== metadata.handle &&
				run.parentSessionId !== undefined &&
				runBackend(run) === "herdr" &&
				!run.herdr?.worktree &&
				run.herdr?.tabId !== undefined,
		)
		.reverse()
		.find((run) => run.herdr?.paneId && getPane(run.herdr.paneId)?.tab_id === run.herdr.tabId);
	const siblingPane = sibling?.herdr?.paneId;
	if (siblingPane) {
		const split = herdr([
			"pane",
			"split",
			siblingPane,
			"--direction",
			splitDirection(siblingPane),
			"--cwd",
			metadata.cwd,
			"--no-focus",
		]);
		return split.pane as PaneResult;
	}
	const args = ["tab", "create", "--label", HERDR_TAB_LABEL, "--cwd", metadata.cwd, "--no-focus"];
	const workspaceId = metadata.herdr?.parentWorkspaceId;
	if (workspaceId) args.push("--workspace", workspaceId);
	return herdr(args).root_pane as PaneResult;
}

function launchHerdrRun(metadata: RunMetadata, initialArgs: string[]): void {
	const worktree = metadata.herdr?.worktree;
	const pane = worktree ? placeInWorktree(metadata, worktree) : placeInSubagentsTab(metadata);
	updateMetadata(metadata.runDir, {
		herdr: {
			...readMetadata(metadata.runDir)?.herdr,
			paneId: pane.pane_id,
			tabId: pane.tab_id,
			workspaceId: pane.workspace_id,
		},
	});
	tryHerdr(["pane", "rename", pane.pane_id, metadata.name ?? metadata.handle]);

	// The pane runs a shell; a script avoids quoting the prompt through it, and `exec` makes the pane close
	// when pi exits so pane liveness tracks the child process.
	const script = join(metadata.runDir, "launch.sh");
	const command = piCommand(metadata, initialArgs).map(shellQuote).join(" ");
	writeFileSync(script, `cd ${shellQuote(metadata.cwd)} || exit 1\nexec ${command}\n`, { mode: 0o700 });
	try {
		herdr(["pane", "run", pane.pane_id, `exec sh ${shellQuote(script)}`]);
	} catch (error) {
		tryHerdr(["pane", "close", pane.pane_id]);
		throw error;
	}
}

/** The window holding a rex block, or undefined when the block no longer exists. */
function rexBlockWindow(sessionId: string, blockId: string): string | undefined {
	const block = tryRex(["block", "inspect", "-s", sessionId, blockId, "--json"])?.block as
		| { window_id?: string }
		| undefined;
	return block?.window_id;
}

/**
 * Split below the parent for the first child, then split siblings to the right within that lower area.
 * Rex passes the command's arguments through unchanged and closes the block when pi exits, so block liveness
 * tracks the child process.
 */
function launchRexRun(metadata: RunMetadata, initialArgs: string[]): void {
	const placement = metadata.rex;
	if (!placement) throw new Error(`${metadata.handle} has no rex placement`);
	const sessionId = placement.sessionId;
	const parentBlockId = process.env.REX_BLOCK || placement.parentBlockId;
	const windowId = parentBlockId ? rexBlockWindow(sessionId, parentBlockId) : undefined;
	if (!parentBlockId || !windowId) throw new Error("The parent Rex block is no longer available");
	const command = piCommand(metadata, initialArgs);
	const label = metadata.name ?? metadata.handle;

	const sibling = listRuns(metadata.parentSessionId)
		.filter(
			(run) =>
				run.handle !== metadata.handle &&
				run.parentSessionId !== undefined &&
				runBackend(run) === "rex" &&
				run.rex?.sessionId === sessionId &&
				run.rex.parentBlockId === parentBlockId &&
				run.rex.blockId !== undefined &&
				run.rex.windowId === windowId,
		)
		.reverse()
		.find((run) => rexBlockWindow(sessionId, run.rex!.blockId!) === windowId && runIsAlive(run));

	const siblingBlockId = sibling?.rex?.blockId;
	const split = rex([
		"split",
		"-s",
		sessionId,
		"-b",
		siblingBlockId ?? parentBlockId,
		"--split",
		siblingBlockId ? "right" : "below",
		"--ratio",
		siblingBlockId ? "50" : "35",
		"-c",
		metadata.cwd,
		"--label",
		label,
		"--focus=false",
		"--json",
		"--",
		...command,
	]);
	const blockId = (split.block_ids as string[])[0];
	updateMetadata(metadata.runDir, {
		rex: { ...readMetadata(metadata.runDir)?.rex, sessionId, parentBlockId, blockId, windowId },
	});
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!runIsAlive(metadata)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
