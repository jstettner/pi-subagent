#!/usr/bin/env node
/**
 * The serial lock server: one per machine that serves a local model, holding the lines and locks of its lanes so
 * that every Pi session using that model takes turns, on this machine or over the tailnet (see serial.ts).
 *
 * It listens on 127.0.0.1 only. Other machines reach it through `tailscale serve`, mounted at `/serial` beside the
 * model server: `tailscale serve --bg --set-path /serial http://127.0.0.1:11500`. Routes work with or without that
 * prefix, whichever way the proxy forwards them.
 *
 * Holders are leases rather than pids, since a pid means nothing on another machine: a client polls `acquire` while
 * it waits and sends `heartbeat` while it holds, and a holder silent for LEASE_MS loses its ticket and lock.
 * State lives in memory; after a restart, holders find their locks gone on the next heartbeat and take new ones.
 *
 *   POST /acquire   {lane, slots, reserved, holder, child} -> {held: slot} | {ahead: n}
 *   POST /heartbeat {holder}                               -> {held: boolean}
 *   POST /release   {holder}                               -> {}
 *   GET  /status                                           -> lanes, holders and lines
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.PI_SERIAL_PORT) || 11500;
const LEASE_MS = 15_000;

interface Ticket {
	readonly holder: string;
	/** Parents 0, subagents 1: a name sort put parents ahead in the file-based line, and this keeps that. */
	readonly priority: number;
	readonly since: number;
	readonly seq: number;
}

interface LaneState {
	slots: (string | undefined)[];
	reserved: number;
	readonly tickets: Map<string, Ticket>;
}

const lanes = new Map<string, LaneState>();
const seen = new Map<string, number>();
let seq = 0;

function laneState(id: string, slots: number, reserved: number): LaneState {
	let lane = lanes.get(id);
	if (!lane) {
		lane = { slots: [], reserved, tickets: new Map() };
		lanes.set(id, lane);
	}
	// Clients carry the lane's shape; the latest wins, and a shrink keeps current holders until they let go.
	while (lane.slots.length < slots) lane.slots.push(undefined);
	while (lane.slots.length > slots && lane.slots.at(-1) === undefined) lane.slots.pop();
	lane.reserved = reserved;
	return lane;
}

function drop(holder: string): void {
	for (const lane of lanes.values()) {
		lane.tickets.delete(holder);
		lane.slots = lane.slots.map((h) => (h === holder ? undefined : h));
	}
	seen.delete(holder);
}

function expire(): void {
	const cutoff = Date.now() - LEASE_MS;
	for (const [holder, at] of seen) if (at < cutoff) drop(holder);
}

const freeSlot = (lane: LaneState, from: number, to: number): number => {
	for (let i = from; i < Math.min(to, lane.slots.length); i++) if (lane.slots[i] === undefined) return i;
	return -1;
};

function acquire(id: string, slots: number, reserved: number, holder: string, child: boolean): object {
	const lane = laneState(id, slots, reserved);
	const mine = lane.slots.indexOf(holder);
	if (mine >= 0) return { held: mine };
	const shared = slots - reserved;
	// A parent takes a reserved lock without joining the line, so it never pushes a child back in it.
	if (!child) {
		const slot = freeSlot(lane, shared, slots);
		if (slot >= 0) {
			lane.slots[slot] = holder;
			lane.tickets.delete(holder);
			return { held: slot };
		}
	}
	if (!lane.tickets.has(holder)) {
		lane.tickets.set(holder, { holder, priority: child ? 1 : 0, since: Date.now(), seq: seq++ });
	}
	const line = [...lane.tickets.values()].sort(
		(a, b) => a.priority - b.priority || a.since - b.since || a.seq - b.seq,
	);
	// Holders of shared locks keep their tickets, so fewer than `shared` tickets ahead means one is free or about to be.
	const position = line.findIndex((t) => t.holder === holder);
	if (position < shared) {
		const slot = freeSlot(lane, 0, shared);
		if (slot >= 0) {
			lane.slots[slot] = holder;
			return { held: slot };
		}
	}
	return { ahead: Math.max(position - shared + 1, 1) };
}

function status(): object {
	const out: Record<string, object> = {};
	for (const [id, lane] of lanes) {
		out[id] = {
			slots: lane.slots.map((h) => h ?? null),
			reserved: lane.reserved,
			line: [...lane.tickets.values()].map((t) => t.holder),
		};
	}
	return { lanes: out, leaseMs: LEASE_MS };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	let body = "";
	for await (const chunk of req) body += chunk;
	return body ? JSON.parse(body) : {};
}

function send(res: ServerResponse, code: number, value: object): void {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
	try {
		expire();
		const route = (req.url ?? "/").split("?")[0].replace(/^\/serial(?=\/|$)/, "") || "/";
		if (req.method === "GET" && (route === "/status" || route === "/")) return send(res, 200, status());
		if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
		const body = await readJson(req);
		const holder = typeof body.holder === "string" ? body.holder : "";
		if (!holder) return send(res, 400, { error: "holder required" });
		if (route === "/release") {
			drop(holder);
			return send(res, 200, {});
		}
		seen.set(holder, Date.now());
		if (route === "/heartbeat") {
			return send(res, 200, { held: [...lanes.values()].some((l) => l.slots.includes(holder)) });
		}
		if (route === "/acquire") {
			const lane = String(body.lane ?? "");
			const slots = Math.max(1, Math.floor(Number(body.slots) || 1));
			const reserved = Math.min(slots - 1, Math.max(0, Math.floor(Number(body.reserved) || 0)));
			if (!lane) return send(res, 400, { error: "lane required" });
			return send(res, 200, acquire(lane, slots, reserved, holder, body.child === true));
		}
		send(res, 404, { error: "not found" });
	} catch (error) {
		send(res, 400, { error: String(error) });
	}
});

server.on("error", (error: NodeJS.ErrnoException) => {
	// Another copy already serves this port: a launch agent, or a Pi session that started one first.
	if (error.code === "EADDRINUSE") process.exit(0);
	throw error;
});
server.listen(PORT, "127.0.0.1");
setInterval(expire, LEASE_MS / 3).unref();
