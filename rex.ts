import { spawnSync } from "node:child_process";

export interface RexProcess {
	child?: { pid: number };
	last_exit?: { exit_code: number; error?: string } | null;
}

export function rexBin(): string {
	return process.env.REX_BIN_PATH || "rex";
}

export function insideRex(): boolean {
	return !!process.env.REX_SESSION && !!process.env.REX_BLOCK;
}

/** Run a rex CLI command and return its JSON output, if any. Throws with rex's error message on failure. */
export function rex(args: string[]): Record<string, unknown> {
	const result = spawnSync(rexBin(), args, { encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const message = result.stderr.trim().replace(/^Error: /, "");
		throw new Error(message || `rex ${args[0]} ${args[1] ?? ""} failed`);
	}
	const output = result.stdout.trim();
	if (!output) return {};
	try {
		return JSON.parse(output) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Like `rex`, but swallows failures. Used for best-effort display updates and cleanup. */
export function tryRex(args: string[]): Record<string, unknown> | undefined {
	try {
		return rex(args);
	} catch {
		return undefined;
	}
}

/** The block's terminal process, or undefined when the block no longer exists. */
export function blockProcess(sessionId: string, blockId: string): RexProcess | undefined {
	return tryRex(["block", "call", "-s", sessionId, "-b", blockId, "process"]) as RexProcess | undefined;
}

/** A block is live while its program runs; Rex keeps a block open after a quick failure so its error stays readable. */
export function blockIsRunning(sessionId: string, blockId: string): boolean {
	const terminal = blockProcess(sessionId, blockId);
	return terminal !== undefined && !terminal.last_exit;
}
