/**
 * Build sample test plan comments for unit testing the TestDesigner and Auditor agents.
 */

/** Build a test plan comment containing a runnable bash command */
export function buildPlanWithCommand(
	options: {
		command?: string;
		extraText?: string;
		language?: string;
	} = {},
): string {
	const cmd = options.command || "node --experimental-strip-types --test test/foo.test.mts";
	const lang = options.language || "bash";
	const extra = options.extraText ? "\n" + options.extraText : "";
	return `## Test Plan${extra}

### Test Command

\`\`\`${lang}
${cmd}
\`\`\`

Run with \`${cmd}\`.`;
}

/** Build a test plan comment with multiple code blocks */
export function buildPlanWithMultipleBlocks(
	options: {
		firstCommand?: string;
		secondCommand?: string;
	} = {},
): string {
	const first = options.firstCommand || "npm install";
	const second =
		options.secondCommand || "node --experimental-strip-types --test test/foo.test.mts";
	return `## Test Plan

### Setup

\`\`\`bash
${first}
\`\`\`

### Run Tests

\`\`\`bash
${second}
\`\`\``;
}

/** Build a test plan comment without any code block */
export function buildPlanWithoutCommand(): string {
	return `## Test Plan

### Scenarios

1. Unit test for parsing
2. Integration test for full flow

Manual testing required.`;
}

/** Build a test plan comment with inline backtick (not a fenced block) */
export function buildPlanWithInlineCode(): string {
	return `## Test Plan

Run tests with \`node --test test/foo.test.mts\` command.`;
}

/** Build a test plan with glob pattern for multiple test files */
export function buildPlanWithGlob(): string {
	return `## Test Plan

\`\`\`bash
node --experimental-strip-types --test test/*.test.*
\`\`\``;
}
