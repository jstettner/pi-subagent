import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { killRun, launchRun, readMetadata, writeMetadata, type RunMetadata } from "./shared.ts";

let root: string;
let savedEnv: NodeJS.ProcessEnv;
let blocks: Record<string, { window_id: string; exited?: boolean }>;

beforeEach(() => {
	savedEnv = { ...process.env };
	root = mkdtempSync(join(tmpdir(), "subagent-rex-test-"));
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.REX_BLOCK = "parent";
	process.env.REX_BIN_PATH = join(root, "rex");
	process.env.REX_TEST_ROOT = root;
	blocks = { parent: { window_id: "parent-window" } };
	writeFileSync(join(root, "calls.jsonl"), "");
	writeFileSync(process.env.REX_BIN_PATH, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.REX_TEST_ROOT;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(args) + "\\n");
const blocks = JSON.parse(fs.readFileSync(path.join(root, "blocks.json"), "utf8"));
const emit = value => console.log(JSON.stringify(value));
if (args[0] === "block" && args[1] === "inspect") {
  const block = blocks[args[4]];
  if (!block) process.exit(1);
  emit({ block });
} else if (args[0] === "block" && args[1] === "call") {
  const block = blocks[args[5]];
  if (!block) process.exit(1);
  emit(block.exited ? { last_exit: { exit_code: 0 } } : { child: { pid: 123 } });
} else if (args[0] === "split") {
  emit({ block_ids: ["new-child", args[args.indexOf("-b") + 1]] });
} else if (args[0] !== "block" || args[1] !== "close") {
  process.exit(1);
}
`, { mode: 0o700 });
});

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnv)) delete process.env[key];
	}
	Object.assign(process.env, savedEnv);
	rmSync(root, { recursive: true, force: true });
});

function run(handle: string, overrides: Partial<RunMetadata> = {}): RunMetadata {
	const runDir = join(root, "subagents", handle);
	const metadata: RunMetadata = {
		version: 1, handle, parentSessionId: "pi-parent", backend: "rex",
		rex: { sessionId: "rex-session" }, runDir, sessionFile: join(runDir, "session.jsonl"),
		cwd: root, provider: "test", model: "test", thinking: "low", state: "starting",
		hasStarted: false, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z",
		...overrides,
	};
	writeMetadata(metadata);
	return metadata;
}

function sibling(overrides: Partial<RunMetadata> = {}): RunMetadata {
	blocks.sibling = { window_id: "parent-window" };
	return run("sibling", {
		rex: { sessionId: "rex-session", parentBlockId: "parent", blockId: "sibling", windowId: "parent-window" },
		...overrides,
	});
}

function launch(metadata: RunMetadata): string[] {
	writeFileSync(join(root, "blocks.json"), JSON.stringify(blocks));
	launchRun(metadata, ["Task: test"]);
	return calls().find(args => args[0] === "split")!;
}

function calls(): string[][] {
	return readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function option(args: string[], name: string): string {
	return args[args.indexOf(name) + 1];
}

test("first child opens below the parent at 35%, preserving focus and launch arguments", () => {
	const metadata = run("first", { name: "Reviewer" });
	const args = launch(metadata);
	assert.equal(option(args, "-b"), "parent");
	assert.equal(option(args, "--split"), "below");
	assert.equal(option(args, "--ratio"), "35");
	assert.equal(option(args, "--label"), "Reviewer");
	assert.equal(option(args, "-c"), root);
	assert.ok(args.includes("--focus=false"));
	assert.equal(args.at(-1), "Task: test");
	assert.deepEqual(readMetadata(metadata.runDir)?.rex, {
		sessionId: "rex-session", parentBlockId: "parent", blockId: "new-child", windowId: "parent-window",
	});
});

test("additional children split a live sibling to the right, never the parent", () => {
	sibling();
	const args = launch(run("second"));
	assert.equal(option(args, "-b"), "sibling");
	assert.equal(option(args, "--split"), "right");
	assert.equal(option(args, "--ratio"), "50");
});

for (const kind of ["exited", "closed", "moved", "other-parent", "legacy-tab", "other-session"] as const) {
	test(`does not anchor to a ${kind} sibling`, () => {
		const previous = sibling();
		if (kind === "exited") blocks.sibling.exited = true;
		if (kind === "closed") delete blocks.sibling;
		if (kind === "moved") blocks.sibling.window_id = "another-window";
		if (kind === "other-parent") previous.parentSessionId = "another-pi-parent";
		if (kind === "legacy-tab") delete previous.rex!.parentBlockId;
		if (kind === "other-session") previous.rex!.sessionId = "another-rex-session";
		writeMetadata(previous);
		const args = launch(run("next"));
		assert.equal(option(args, "-b"), "parent");
		assert.equal(option(args, "--split"), "below");
	});
}

test("resume anchors to the current parent block instead of stale placement", () => {
	sibling();
	process.env.REX_BLOCK = "resumed-parent";
	blocks["resumed-parent"] = { window_id: "resumed-window" };
	const metadata = run("resumed", { rex: { sessionId: "rex-session", parentBlockId: "parent" } });
	const args = launch(metadata);
	assert.equal(option(args, "-b"), "resumed-parent");
	assert.equal(readMetadata(metadata.runDir)?.rex?.windowId, "resumed-window");
});

test("missing parent fails instead of splitting the focused pane or creating a tab", () => {
	delete blocks.parent;
	assert.throws(() => launch(run("orphan")), /parent Rex block is no longer available/);
	assert.ok(calls().every(args => args[0] !== "split" && args[0] !== "window"));
});

test("stopping a child closes only its block", () => {
	const metadata = run("first");
	launch(metadata);
	killRun(readMetadata(metadata.runDir)!);
	assert.deepEqual(calls().at(-1), ["block", "close", "-s", "rex-session", "new-child"]);
	assert.ok(calls().every(args => args[0] !== "window"));
});
