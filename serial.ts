/**
 * Serial mode: when on, subagents on a local single-slot provider take turns running whole tasks
 * instead of interleaving model calls. A server such as Ollama with OLLAMA_NUM_PARALLEL=1 keeps one
 * KV cache slot, so interleaved agents evict each other and re-prefill their whole context on every
 * call. Here a subagent takes a machine-wide FIFO lock before its first model call and holds it until
 * its run settles, so each follow-up call only prefills what's new.
 *
 * `/serial` toggles it from any Pi. The flag is a file, so running subagents see it at once. It lives
 * in this extension rather than a standalone one because children keep this extension under
 * `--no-extensions`. Only children wait; the parent never does, so it can't deadlock on its own
 * children while it waits for them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./shared.ts";

/** Providers whose server keeps a single cache slot; hosted providers cache every prefix and never wait. */
const SERIAL_PROVIDERS = new Set(["ollama"]);
const STATUS_KEY = "serial";
const POLL_MS = 500;

const root = (): string => join(getAgentDir(), "serial-subagents");
const flagFile = (): string => join(root(), "enabled");
const queueDir = (): string => join(root(), "queue"); // one ticket per waiter or holder: `<ms>-<pid>`
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

/** Live tickets in arrival order, removing those of processes that died. */
function liveTickets(): string[] {
	return readdirSync(queueDir())
		.sort()
		.filter((name) => {
			if (alive(Number(name.split("-")[1]))) return true;
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

/** Registers `/serial` everywhere, and the lock itself in subagent children. */
export function registerSerial(pi: ExtensionAPI, isChild: boolean): void {
	pi.registerCommand("serial", {
		description: "Toggle running local-model subagents one at a time, keeping the KV cache warm",
		handler: async (_args, ctx) => {
			mkdirSync(root(), { recursive: true });
			if (serialEnabled()) rmSync(flagFile(), { force: true });
			else writeFileSync(flagFile(), "");
			ctx.ui.notify(`serial subagents: ${serialEnabled() ? "on" : "off"}`, "info");
		},
	});

	if (!isChild) return;

	let ticket: string | undefined;
	let held = false;

	const release = (ctx?: ExtensionContext): void => {
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
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	};

	const acquire = async (ctx: ExtensionContext): Promise<void> => {
		mkdirSync(queueDir(), { recursive: true });
		ticket ??= `${String(Date.now()).padStart(15, "0")}-${process.pid}`;
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
		release(ctx); // turned off or aborted while waiting
	};

	// Fires before every model call: block the first call of a run until it's this agent's turn.
	pi.on("context", async (_event, ctx) => {
		if (held || !serialEnabled() || !ctx.model || !SERIAL_PROVIDERS.has(ctx.model.provider)) return;
		await acquire(ctx);
	});

	// Hold through retries, compactions and queued follow-ups; let go once the run is over.
	pi.on("agent_settled", (_event, ctx) => release(ctx));
	// A dialog waiting on a person shouldn't stall the other agents.
	pi.on("ui_prompt_start", (_event, ctx) => release(ctx));
	pi.on("session_shutdown", (_event, ctx) => release(ctx));
	process.once("exit", () => release());
}
