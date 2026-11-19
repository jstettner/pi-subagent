/**
 * Serial mode: when on, Pi sessions on a local provider take turns on the model instead of
 * interleaving more calls than its server has KV cache slots. A server such as Ollama with
 * OLLAMA_NUM_PARALLEL=1 keeps one slot, and llama-server `-np N` keeps N, so more agents than slots
 * evict each other and re-prefill their whole context on every call. Here each session takes one of
 * its provider's machine-wide locks before its first model call and keeps it while it works, so each
 * follow-up call only prefills what's new. Each provider has its own line and locks (`LANES`).
 *
 * - A subagent holds the lock until its run settles, then the next in line takes it.
 * - A parent goes ahead of every waiting subagent: it waits only for the current holder to settle.
 *   It lets go when it settles or blocks on a tool (a `subagent wait`, or any tool still running after
 *   TOOL_RELEASE_MS), so its children can run while it waits on them.
 *
 * While a session waits in line it reports a `serial` record of `blocked` to the terminal (OSC 7501, the
 * Program Status Protocol), beside the root record Pi itself keeps, and clears it once it holds a lock.
 *
 * `/serial` toggles it from any Pi. The flag is a file, so running sessions see it at once. It lives in
 * this extension rather than a standalone one because children keep this extension under
 * `--no-extensions`.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { getSerialDir, serialEnabled } from "./shared.ts";

/**
 * A local provider's locks: `slots` in all, as many as its server has KV cache slots, of which `reserved` only parents
 * take, so a parent never waits for one of its children's whole tasks to end. Hosted providers cache every prefix and
 * never wait.
 */
interface Lane {
	readonly slots: number;
	readonly reserved: number;
}

const LANES: ReadonlyMap<string, Lane> = new Map([
	["ollama", { slots: 1, reserved: 0 }],
	["llama-local", { slots: 8, reserved: 1 }], // llama-server -np 8
]);
const STATUS_KEY = "serial";
const POLL_MS = 500;
/** A parent's tool that runs this long is treated as waiting on something, and the parent lets go. */
const TOOL_RELEASE_MS = 20_000;
const SUBAGENT_WAIT = /\bsubagent\s+wait\b/;

const root = getSerialDir;
const flagFile = (): string => join(root(), "enabled");
// One ticket per waiter or holder, `<priority><ms>-<pid>`, the time padded to 15 digits: parents `0`, subagents `1`,
// so a name sort is the line. The pid stays the second field, as in tickets without a priority digit (`<ms>-<pid>`),
// which sort between the two.
// Ollama's lane keeps the original names (`queue`, `held`), so sessions started before lanes still share its line.
const queueDir = (provider: string): string => join(root(), provider === "ollama" ? "queue" : `queue-${provider}`);
/** mkdir is the atomic lock; `pid` inside names the holder. */
const heldDir = (provider: string, slot: number): string =>
	join(root(), provider === "ollama" && slot === 0 ? "held" : `held-${provider}-${slot}`);

/** The record this extension owns beside Pi's root record; Pi rewrites the root on its own events. */
const RECORD_ID = "serial";

const writeRecord = (pairs: string): void => {
	if (process.stdout.isTTY) process.stdout.write(`\x1b]7501;${pairs}\x1b\\`);
};

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** Live tickets in line order, removing those of processes that died. */
function liveTickets(provider: string): string[] {
	const dir = queueDir(provider);
	return readdirSync(dir)
		.sort()
		.filter((name) => {
			if (alive(Number(name.split("-")[1]))) return true;
			rmSync(join(dir, name), { force: true });
			return false;
		});
}

function tryTakeHeld(dir: string): boolean {
	try {
		mkdirSync(dir);
		writeFileSync(join(dir, "pid"), String(process.pid));
		return true;
	} catch {
		// Take over from a holder that died without releasing.
		let holder: number;
		try {
			holder = Number(readFileSync(join(dir, "pid"), "utf8"));
		} catch {
			return false; // being created right now
		}
		if (!Number.isNaN(holder) && !alive(holder)) rmSync(dir, { recursive: true, force: true });
		return false;
	}
}

/** Takes the first free lock numbered `from` to `to` (exclusive), returning its directory. */
function tryTakeSlot(provider: string, from: number, to: number): string | undefined {
	for (let slot = from; slot < to; slot++) {
		const dir = heldDir(provider, slot);
		if (tryTakeHeld(dir)) return dir;
	}
	return undefined;
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
	let ticketDir: string | undefined;
	let held: string | undefined; // the lock directory this session holds
	let reported: string | undefined; // the waiting message last reported to the terminal

	const reportWaiting = (message: string): void => {
		if (message === reported) return;
		reported = message;
		writeRecord(`state=blocked:id=${RECORD_ID}:msg=${Buffer.from(message).toString("base64")}`);
	};
	const clearWaiting = (): void => {
		if (reported === undefined) return;
		reported = undefined;
		writeRecord(`state=clear:id=${RECORD_ID}`);
	};
	let lastCtx: ExtensionContext | undefined;
	const toolTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const release = (): void => {
		if (held) {
			try {
				if (readFileSync(join(held, "pid"), "utf8") === String(process.pid)) {
					rmSync(held, { recursive: true, force: true });
				}
			} catch {}
		}
		if (ticket && ticketDir) rmSync(join(ticketDir, ticket), { force: true });
		held = undefined;
		ticket = undefined;
		ticketDir = undefined;
		clearWaiting();
		try {
			lastCtx?.ui.setStatus(STATUS_KEY, undefined);
		} catch {} // ctx goes stale once the session shuts down
	};

	const acquire = async (ctx: ExtensionContext, provider: string, lane: Lane): Promise<void> => {
		const shared = lane.slots - lane.reserved;
		const { theme } = ctx.ui;
		const running = (lock: string): void => {
			held = lock;
			clearWaiting();
			ctx.ui.setStatus(STATUS_KEY, theme.fg("success", "serial: running"));
		};
		// A parent takes a reserved lock without joining the line, so it never pushes a child back in it.
		const reserved = isChild ? undefined : tryTakeSlot(provider, shared, lane.slots);
		if (reserved) return running(reserved);

		ticketDir = queueDir(provider);
		mkdirSync(ticketDir, { recursive: true });
		ticket ??= `${priority}${String(Date.now()).padStart(15, "0")}-${process.pid}`;
		while (!ctx.signal?.aborted) {
			if (!serialEnabled()) break;
			// (Re)write the ticket each time: another process may have pruned it.
			writeFileSync(join(ticketDir, ticket), "");
			// Holders of shared locks keep their tickets, so fewer than `shared` tickets ahead means one is free or about to be.
			const position = liveTickets(provider).indexOf(ticket);
			const taken = position >= 0 && position < shared ? tryTakeSlot(provider, 0, shared) : undefined;
			if (taken) return running(taken);
			const freed = isChild ? undefined : tryTakeSlot(provider, shared, lane.slots);
			if (freed) {
				rmSync(join(ticketDir, ticket), { force: true }); // out of the line, as if it had taken it at once
				ticket = undefined;
				return running(freed);
			}
			const ahead = Math.max(position - shared + 1, 1);
			ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `serial: waiting (#${ahead} in queue)`));
			reportWaiting(`Waiting for a slot on ${provider} (#${ahead} in line)`);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
		}
		release(); // turned off or aborted while waiting
	};

	// Fires before every model call: block until it's this session's turn.
	pi.on("context", async (_event, ctx) => {
		lastCtx = ctx;
		if (held || !serialEnabled() || !ctx.model) return;
		const lane = LANES.get(ctx.model.provider);
		if (lane === undefined) return;
		await acquire(ctx, ctx.model.provider, lane);
	});

	// Hold through retries, compactions and queued follow-ups; let go once the run is over.
	pi.on("agent_settled", () => release());
	// A dialog waiting on a person shouldn't stall the other agents.
	pi.on("ui_prompt_start", () => release());
	pi.on("session_shutdown", () => {
		release();
		lastCtx = undefined;
	});
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
