/**
 * Serial mode: when on, Pi sessions on a local single-slot provider take turns on the model instead
 * of interleaving calls. A server such as Ollama with OLLAMA_NUM_PARALLEL=1 keeps one KV cache slot,
 * so interleaved agents evict each other and re-prefill their whole context on every call. Here each
 * session takes a machine-wide lock before its first model call and keeps it while it works, so each
 * follow-up call only prefills what's new.
 *
 * - A subagent holds the lock until its run settles, then the next in line takes it.
 * - A parent goes ahead of every waiting subagent: it waits only for the current holder to settle.
 *   It lets go when it settles or blocks on a tool (a `subagent wait`, or any tool still running after
 *   TOOL_RELEASE_MS), so its children can run while it waits on them.
 *
 * `/serial` toggles it from any Pi. The flag is a file, so running sessions see it at once. It lives in
 * this extension rather than a standalone one because children keep this extension under
 * `--no-extensions`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./shared.ts";

/** Providers whose server keeps a single cache slot; hosted providers cache every prefix and never wait. */
const SERIAL_PROVIDERS = new Set(["ollama"]);
const STATUS_KEY = "serial";
const POLL_MS = 500;
/** A parent's tool that runs this long is treated as waiting on something, and the parent lets go. */
const TOOL_RELEASE_MS = 20_000;
const SUBAGENT_WAIT = /\bsubagent\s+wait\b/;

const root = (): string => join(getAgentDir(), "serial-subagents");
const flagFile = (): string => join(root(), "enabled");
// One ticket per waiter or holder, `<priority>-<ms>-<pid>`: parents `0`, subagents `1`, so a name sort is the line.
const queueDir = (): string => join(root(), "queue");
const heldDir = (): string => join(root(), "held"); // mkdir is the atomic lock; `pid` inside names the holder

export const serialEnabled = (): boolean => existsSync(flagFile());

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** Live tickets in line order, removing those of processes that died. */
function liveTickets(): string[] {
	return readdirSync(queueDir())
		.sort()
		.filter((name) => {
			if (alive(Number(name.split("-").at(-1)))) return true;
			rmSync(join(queueDir(), name), { force: true });
			return false;
		});
}

function tryTakeHeld(): boolean {
	try {
		mkdirSync(heldDir());
		writeFileSync(join(heldDir(), "pid"), String(process.pid));
		return true;
	} catch {
		// Take over from a holder that died without releasing.
		let holder: number;
		try {
			holder = Number(readFileSync(join(heldDir(), "pid"), "utf8"));
		} catch {
			return false; // being created right now
		}
		if (!Number.isNaN(holder) && !alive(holder)) rmSync(heldDir(), { recursive: true, force: true });
		return false;
	}
}

/** Registers `/serial` everywhere, and the lock in every session that calls a serial provider. */
export function registerSerial(pi: ExtensionAPI, isChild: boolean): void {
	pi.registerCommand("serial", {
		description: "Toggle running local-model agents one at a time, keeping the KV cache warm",
		handler: async (_args, ctx) => {
			mkdirSync(root(), { recursive: true });
			if (serialEnabled()) rmSync(flagFile(), { force: true });
			else writeFileSync(flagFile(), "");
			ctx.ui.notify(`serial subagents: ${serialEnabled() ? "on" : "off"}`, "info");
		},
	});

	const priority = isChild ? 1 : 0;
	let ticket: string | undefined;
	let held = false;
	let lastCtx: ExtensionContext | undefined;
	const toolTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const release = (): void => {
		if (held) {
			try {
				if (readFileSync(join(heldDir(), "pid"), "utf8") === String(process.pid)) {
					rmSync(heldDir(), { recursive: true, force: true });
				}
			} catch {}
		}
		if (ticket) rmSync(join(queueDir(), ticket), { force: true });
		held = false;
		ticket = undefined;
		lastCtx?.ui.setStatus(STATUS_KEY, undefined);
	};

	const acquire = async (ctx: ExtensionContext): Promise<void> => {
		mkdirSync(queueDir(), { recursive: true });
		ticket ??= `${priority}-${String(Date.now()).padStart(15, "0")}-${process.pid}`;
		writeFileSync(join(queueDir(), ticket), "");
		const { theme } = ctx.ui;
		while (!ctx.signal?.aborted) {
			if (!serialEnabled()) break;
			const position = liveTickets().indexOf(ticket);
			if (position === 0 && tryTakeHeld()) {
				held = true;
				ctx.ui.setStatus(STATUS_KEY, theme.fg("success", "serial: running"));
				return;
			}
			ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `serial: waiting (#${Math.max(position, 1)} in queue)`));
			await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
		}
		release(); // turned off or aborted while waiting
	};

	// Fires before every model call: block until it's this session's turn.
	pi.on("context", async (_event, ctx) => {
		lastCtx = ctx;
		if (held || !serialEnabled() || !ctx.model || !SERIAL_PROVIDERS.has(ctx.model.provider)) return;
		await acquire(ctx);
	});

	// Hold through retries, compactions and queued follow-ups; let go once the run is over.
	pi.on("agent_settled", () => release());
	// A dialog waiting on a person shouldn't stall the other agents.
	pi.on("ui_prompt_start", () => release());
	pi.on("session_shutdown", () => release());
	process.once("exit", () => release());

	if (isChild) return;

	// A parent must not hold the lock while it waits on its children, or neither side moves.
	pi.on("tool_call", (event) => {
		if (held && isToolCallEventType("bash", event) && SUBAGENT_WAIT.test(event.input.command)) release();
	});
	pi.on("tool_execution_start", (event) => {
		if (!held) return;
		toolTimers.set(event.toolCallId, setTimeout(release, TOOL_RELEASE_MS));
	});
	pi.on("tool_execution_end", (event) => {
		clearTimeout(toolTimers.get(event.toolCallId));
		toolTimers.delete(event.toolCallId);
	});
}
