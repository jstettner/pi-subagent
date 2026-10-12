import { spawnSync } from "node:child_process";

/** Metadata source for display labels reported on subagent panes. */
export const HERDR_METADATA_SOURCE = "pi-subagent";

/** Label of the tab that groups the subagents of one parent session. */
export const HERDR_TAB_LABEL = "subagents";

export interface HerdrPane {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	agent?: string;
	agent_session?: { value?: string };
}

export function herdrBin(): string {
	return process.env.HERDR_BIN_PATH || "herdr";
}

export function insideHerdr(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH;
}

/** Run a herdr CLI command and return its JSON `result`. Throws with the server error message on failure. */
export function herdr(args: string[]): Record<string, unknown> {
	const result = spawnSync(herdrBin(), args, { encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		let message = result.stderr.trim() || `herdr ${args[0]} ${args[1] ?? ""} failed`;
		try {
			const parsed = JSON.parse(result.stderr) as { error?: { message?: string } };
			if (parsed.error?.message) message = parsed.error.message;
		} catch {
			// Not a JSON server error.
		}
		throw new Error(message);
	}
	const output = result.stdout.trim();
	if (!output) return {};
	return (JSON.parse(output) as { result?: Record<string, unknown> }).result ?? {};
}

/** Like `herdr`, but swallows failures. Used for best-effort display updates and cleanup. */
export function tryHerdr(args: string[]): Record<string, unknown> | undefined {
	try {
		return herdr(args);
	} catch {
		return undefined;
	}
}

export function getPane(paneId: string): HerdrPane | undefined {
	return tryHerdr(["pane", "get", paneId])?.pane as HerdrPane | undefined;
}

export function listPanes(): HerdrPane[] {
	return (tryHerdr(["pane", "list"])?.panes as HerdrPane[] | undefined) ?? [];
}

/** Find the live pane running pi on `sessionFile`, e.g. after the pane was moved or restored by herdr. */
export function findPaneBySession(sessionFile: string): HerdrPane | undefined {
	return listPanes().find((pane) => pane.agent === "pi" && pane.agent_session?.value === sessionFile);
}

export function tabExists(tabId: string): boolean {
	return tryHerdr(["tab", "get", tabId]) !== undefined;
}

/** Split right when the pane is wide, down when it is tall (terminal cells are roughly twice as tall as wide). */
export function splitDirection(paneId: string): "right" | "down" {
	const layout = tryHerdr(["pane", "layout", "--pane", paneId])?.layout as
		| { panes?: { pane_id: string; rect: { width: number; height: number } }[] }
		| undefined;
	const rect = layout?.panes?.find((pane) => pane.pane_id === paneId)?.rect;
	if (!rect) return "right";
	return rect.width >= rect.height * 2.5 ? "right" : "down";
}

/** Herdr agent names must match `[a-z][a-z0-9_-]{0,31}`; keep the handle so names stay unique. */
export function herdrAgentName(handle: string, name?: string): string {
	const slug = (name ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/-+$/, "")
		.slice(0, 24)
		.replace(/-+$/, "");
	return `${slug || "sub"}-${handle}`;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
