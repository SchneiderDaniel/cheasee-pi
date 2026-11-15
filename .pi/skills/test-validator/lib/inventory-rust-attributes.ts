// Domain: which attributes sit in front of a Rust item.
//
// An attribute reaches its function through the contiguous block above the `fn`
// line, so a scanner that only reads the preceding line loses `#[test]` whenever
// a second attribute (`#[should_panic]`, `#[ignore]`, a helper) sits between them.

/** `#[path::to::attr]`, `#[attr(args)]`, or `#[attr = "value"]`. */
const ATTRIBUTE = /#\[\s*([A-Za-z_][A-Za-z0-9_:]*)\s*(?:[=(].*)?\]/g;

/** One attribute, at the source line it was written on. */
export interface Attribute {
	readonly line: number;
	readonly path: string;
}

/** The attribute paths on one line, empty when it carries none. */
export function attributesOf(line: string): string[] {
	const paths: string[] = [];
	for (const match of line.matchAll(ATTRIBUTE)) paths.push(match[1]);
	return paths;
}

/** Every attribute on every line that carries one, keyed by 1-based line. */
export function attributeIndex(structural: readonly string[]): Map<number, string[]> {
	const byLine = new Map<number, string[]>();
	for (const [index, line] of structural.entries()) {
		const paths = attributesOf(line);
		if (paths.length > 0) byLine.set(index + 1, paths);
	}
	return byLine;
}

export function lastSegment(path: string): string {
	return path.split(":").at(-1) ?? path;
}

export function isTestAttribute(path: string): boolean {
	return lastSegment(path) === "test";
}

export function isIgnoreAttribute(path: string): boolean {
	return lastSegment(path) === "ignore";
}

/** Blank lines and `//` comments may sit inside an attribute block. */
function isFiller(trimmed: string): boolean {
	return trimmed === "" || trimmed.startsWith("//");
}

/**
 * Attributes attached to the function at `index`: the ones sharing its line
 * before `fn`, plus the contiguous attribute block above it. The walk upward
 * skips filler lines and stops at the first line that is neither an attribute nor
 * filler.
 */
export function attributesAttachedTo(
	structural: readonly string[],
	index: number,
	attributesByLine: Map<number, string[]>,
): Attribute[] {
	const attached: Attribute[] = [];
	const fnAt = structural[index].search(/\bfn\s+/);
	if (fnAt > 0) {
		for (const path of attributesOf(structural[index].slice(0, fnAt))) {
			attached.push({ line: index + 1, path });
		}
	}
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const paths = attributesByLine.get(cursor + 1);
		if (paths !== undefined) {
			for (const path of paths) attached.push({ line: cursor + 1, path });
			continue;
		}
		if (isFiller(structural[cursor].trim())) continue;
		break;
	}
	return attached;
}
