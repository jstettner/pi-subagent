import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { wholeDiskScan } from "./disk-scan.ts";

test("blocks searches of the whole disk or the home directory", () => {
	const blocked = [
		`find / -maxdepth 6 -type d -path "*node_modules/@effect/sql" 2>/dev/null | head`,
		"ls node_modules/effect/dist | head -3; find / -name package.json",
		"find ~ -name '*.ts'",
		"find $HOME -type f",
		`find ${homedir()} -name x`,
		"sudo find /Users -name foo",
		"rg -l 'SqlClient' /",
		"fd sql ~/",
		"grep -rn foo /Library",
		"cd /tmp && du -sh /",
		"ls -laR /",
		"echo $(find / -name foo)",
		"FOO=1 find '/' -name foo",
	];
	for (const command of blocked) assert.ok(wholeDiskScan(command), command);
});

test("allows searches of a project or a shallow listing", () => {
	const allowed = [
		"find . -path '*node_modules/@effect/sql'",
		"find /Users/stet/src/ambral -name '*.ts'",
		"find / -maxdepth 1 -type d",
		"rg SqlClient packages/",
		"grep -n foo /etc/hosts",
		"ls -la /",
		"ls ~",
		"cat / 2>/dev/null",
		"node -p \"require.resolve('effect/package.json')\"",
	];
	for (const command of allowed) assert.equal(wholeDiskScan(command), undefined, command);
});
