/**
 * Serial mode: when on, Pi sessions on a local model take turns on it instead of interleaving more
 * calls than its server has KV cache slots. A server such as Ollama with OLLAMA_NUM_PARALLEL=1 keeps
 * one slot, and llama-server `-np N` keeps N, so more agents than slots evict each other and re-prefill
 * their whole context on every call. Here each session takes one of its lane's locks before its first
 * model call and keeps it while it works, so each follow-up call only prefills what's new. Each provider
 * has its own line and locks (`LANES`), and so does a model listed there by itself: Ollama's MLX engine
 * gives each model its own runner and slots.
 *
 * The locks live in a lock server (serial-server.ts) on the machine that serves the model, so sessions
 * on other machines reaching it over the tailnet wait in the same line as local ones:
 * - a model at a loopback address uses this machine's lock server, which the first session to need it starts;
 * - a model at a `*.ts.net` address uses the lock server mounted at `/serial` on the same host by `tailscale serve`.
 * Hosted models cache every prefix and never wait. A model-level lane matches the model by name under any provider,
 * so a remote provider named anything shares the line with the host's own `ollama`.
 *
 * - A subagent holds the lock until its run settles, then the next in line takes it.
 * - A parent goes ahead of every waiting subagent: it waits only for the current holder to settle.
 *   It lets go when it settles or blocks on a tool (a `subagent wait`, or any tool still running after
 *   TOOL_RELEASE_MS), so its children can run while it waits on them.
 * - A lock is a lease: the holder heartbeats while it holds, and one that goes silent (crashed, asleep,
 *   off the tailnet) loses it after the server's lease. If the lock server can't be reached, the session
 *   runs without a lock rather than stall.
 *
 * While a session waits in line it reports a `serial` record of `blocked` to the terminal (OSC 7501, the
 * Program Status Protocol), beside the root record Pi itself keeps, and clears it once it holds a lock.
 *
 * `/serial` toggles it from any Pi on this machine. The flag is a file, so running sessions see it at once.
 * It lives in this extension rather than a standalone one because children keep this extension under
 * `--no-extensions`.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { getSerialDir, serialEnabled } from "./shared.ts";

/**
 * A local model's locks: `slots` in all, as many as its server has KV cache slots, of which `reserved` only parents
 * take, so a parent never waits for one of its children's whole tasks to end.
 */
interface Lane {
	readonly slots: number;
	readonly reserved: number;
}

/** Keyed by model (Ollama's `:tag` dropped) for a model with slots of its own, or else by provider. */
const LANES: ReadonlyMap<string, Lane> = new Map([
	["inkling-2-mini", { slots: 8, reserved: 1 }], // OLLAMA_NUM_PARALLEL=8, MLX runner
	["ollama", { slots: 1, reserved: 0 }],
	["llama-local", { slots: 8, reserved: 1 }], // llama-server -np 8
]);

/** The lane a model call waits in, and its id: the model's own lane if it has one, else its provider's. */
function laneFor(provider: string, model: string): [string, Lane] | undefined {
	const own = model.split(":")[0];
	const lane = LANES.get(own);
	if (lane) return [own, lane];
	const shared = LANES.get(provider);
	return shared && [provider, shared];
}

const LOCAL_PORT = Number(process.env.PI_SERIAL_PORT) || 11500;
const LOCAL_SERVER = `http://127.0.0.1:${LOCAL_PORT}`;
const SERVER_SCRIPT = fileURLToPath(new URL("./serial-server.ts", import.meta.url));

/** The lock server for a model's base URL: this machine's for loopback, the host's `/serial` for the tailnet. */
function lockServer(baseUrl: string): string | undefined {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return undefined;
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "::1" || host.startsWith("127.")) return LOCAL_SERVER;
	if (host.endsWith(".ts.net")) return `${url.origin}/serial`;
	return undefined;
}

/** Starts this machine's lock server, detached so it outlives this session; a second copy exits on its own. */
function startLocalServer(): void {
	const child = spawn(process.execPath, [SERVER_SCRIPT], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, PI_SERIAL_PORT: String(LOCAL_PORT) },
	});
	child.on("error", () => {});
	child.unref();
}

async function call(server: string, route: string, body: object): Promise<Record<string, unknown>> {
	const res = await fetch(`${server}/${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(5000),
	});
	if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
	return (await res.json()) as Record<string, unknown>;
}

const STATUS_KEY = "serial";
const POLL_MS = 500;
const HEARTBEAT_MS = 5000;
/** Failed calls in a row before a session gives up on a lock server and runs without a lock. */
const MAX_FAILURES = 10;
/** How long a session skips a lock server it gave up on, so each model call doesn't wait out the failures again. */
const UNREACHABLE_MS = 60_000;
/** A parent's tool that runs this long is treated as waiting on something, and the parent lets go. */
const TOOL_RELEASE_MS = 20_000;
const SUBAGENT_WAIT = /\bsubagent\s+wait\b/;

const root = getSerialDir;
const flagFile = (): string => join(root(), "enabled");

/** The record this extension owns beside Pi's root record; Pi rewrites the root on its own events. */
const RECORD_ID = "serial";

const writeRecord = (pairs: string): void => {
	if (process.stdout.isTTY) process.stdout.write(`\x1b]7501;${pairs}\x1b\\`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/** Registers `/serial` everywhere, and the lock in every session that calls a serial provider or model. */
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

	// Unique across machines and across restarts of a pid.
	const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
	let held: string | undefined; // the lock server this session holds a lock on
	let waitingOn: string | undefined; // the lock server this session is in line at
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let reported: string | undefined; // the waiting message last reported to the terminal
	const unreachableUntil = new Map<string, number>();

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
		const server = held ?? waitingOn;
		if (server) call(server, "release", { holder }).catch(() => {}); // the lease expires if this never lands
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		held = undefined;
		waitingOn = undefined;
		clearWaiting();
		try {
			lastCtx?.ui.setStatus(STATUS_KEY, undefined);
		} catch {} // ctx goes stale once the session shuts down
	};

	const acquire = async (ctx: ExtensionContext, server: string, laneId: string, lane: Lane): Promise<void> => {
		const { theme } = ctx.ui;
		const where = server === LOCAL_SERVER ? laneId : `${laneId} on ${new URL(server).hostname.split(".")[0]}`;
		let failures = 0;
		waitingOn = server;
		while (!ctx.signal?.aborted && serialEnabled()) {
			let reply: Record<string, unknown>;
			try {
				reply = await call(server, "acquire", { lane: laneId, ...lane, holder, child: isChild });
				failures = 0;
			} catch {
				failures++;
				if (failures === 1 && server === LOCAL_SERVER) startLocalServer();
				if (failures >= MAX_FAILURES) {
					unreachableUntil.set(server, Date.now() + UNREACHABLE_MS);
					release();
					ctx.ui.setStatus(STATUS_KEY, theme.fg("error", "serial: lock server unreachable"));
					return;
				}
				await sleep(POLL_MS);
				continue;
			}
			if (typeof reply.held === "number") {
				held = server;
				waitingOn = undefined;
				clearWaiting();
				ctx.ui.setStatus(STATUS_KEY, theme.fg("success", "serial: running"));
				heartbeat = setInterval(() => {
					call(server, "heartbeat", { holder })
						.then((beat) => {
							// The lease lapsed (asleep, or the server restarted): the next model call takes a lock again.
							if (beat.held === false && held === server) release();
						})
						.catch(() => {});
				}, HEARTBEAT_MS);
				heartbeat.unref();
				return;
			}
			const ahead = Number(reply.ahead) || 1;
			ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `serial: waiting (#${ahead} in queue)`));
			reportWaiting(`Waiting for a slot on ${where} (#${ahead} in line)`);
			await sleep(POLL_MS);
		}
		release(); // turned off or aborted while waiting
	};

	// Fires before every model call: block until it's this session's turn.
	pi.on("context", async (_event, ctx) => {
		lastCtx = ctx;
		if (held || !serialEnabled() || !ctx.model) return;
		const found = laneFor(ctx.model.provider, ctx.model.id);
		const server = found && lockServer(ctx.model.baseUrl);
		if (!found || !server || (unreachableUntil.get(server) ?? 0) > Date.now()) return;
		await acquire(ctx, server, ...found);
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
