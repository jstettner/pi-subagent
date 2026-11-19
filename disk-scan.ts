/**
 * Disk-scan guard: blocks bash commands that search the whole disk or the home directory, such as
 * `find / -name foo` or `rg pattern ~`. Agents reach for them to locate a file or package, and they run for
 * hours: the agent sits in one tool call, and in serial mode holds a lock the whole time. The block tells the
 * agent to search where the thing can be instead.
 *
 * It lives in this extension rather than a standalone one because children keep this extension under
 * `--no-extensions`, as with serial mode.
 */
import { homedir } from "node:os";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

const home = homedir();
/** Paths too large to search: the root, the home directory, and the top-level directories that hold everything. */
const ROOTS = new Set(
	["/", "/Users", "/System", "/Library", "/Volumes", "/private", "/home", "~", "$HOME", "${HOME}", home].flatMap(
		(path) => (path === "/" ? [path] : [path, `${path}/`]),
	),
);
/** Searches whose every path argument is walked recursively. */
const RECURSIVE = new Set(["find", "fd", "fdfind", "rg", "ag", "du", "tree"]);
/** Searches that walk their paths only when given a recursive flag. */
const WITH_FLAG: Record<string, RegExp> = {
	grep: /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$/,
	ls: /^-[a-zA-Z]*R[a-zA-Z]*$/,
};
/** Words that run the next word as a command. */
const PREFIXES = new Set(["sudo", "time", "nice", "nohup", "command", "exec", "xargs"]);
const SHALLOW = 2; // `find / -maxdepth 2` lists, it doesn't search

const unquote = (word: string): string => word.replace(/^(['"])(.*)\1$/, "$2");

/** Returns the scanned path when `command` searches the whole disk or the home directory. */
export function wholeDiskScan(command: string): string | undefined {
	for (const segment of command.split(/\|\||&&|[;|&\n()`]|\$\(/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
		while (words.length > 0 && (PREFIXES.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
		const [program = "", ...args] = words;
		const name = program.split("/").pop() ?? "";
		const flag = WITH_FLAG[name];
		if (!RECURSIVE.has(name) && !(flag && args.some((arg) => flag.test(arg)))) continue;
		const depth = args.indexOf("-maxdepth");
		if (name === "find" && depth >= 0 && Number(args[depth + 1]) <= SHALLOW) continue;
		const root = args.find((arg) => ROOTS.has(arg));
		if (root) return root;
	}
	return undefined;
}

export function registerDiskScanGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const root = wholeDiskScan(event.input.command);
		if (!root) return;
		return {
			block: true,
			reason:
				`Blocked: this searches all of \`${root}\`, which takes hours. Search where the file can be instead: ` +
				"the working directory or a path you know (`find . -path '*node_modules/<pkg>'`, " +
				"`ls node_modules/<pkg>`), or ask Node where a package resolves " +
				"(`node -p \"require.resolve('<pkg>/package.json')\"`).",
		};
	});
}
