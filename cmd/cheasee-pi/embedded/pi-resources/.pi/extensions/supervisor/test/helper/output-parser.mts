/**
 * Parse TAP (Test Anything Protocol) and Node.js test runner output
 * to extract failed test names.
 */

/**
 * Parse stdout/stderr from test execution to extract failed test names.
 *
 * Supports:
 * - Node built-in test runner format (TAP-like):
 *   `not ok 1 - test description`
 *   `✗ test description`
 * - FAIL markers:
 *   `FAIL test description`
 *   `# FAIL 1`
 * - Assertion error messages
 */
export function parseFailedTests(stdout: string, stderr: string): string[] {
	const combined = stdout + "\n" + stderr;
	const failures: string[] = [];
	const seen = new Set<string>();

	// Pattern 1: TAP format "not ok N - description"
	const tapPattern = /^not ok\s+\d+\s*[-–—]\s*(.+)$/gm;
	let match;
	while ((match = tapPattern.exec(combined)) !== null) {
		const name = match[1]!.trim();
		if (name && !seen.has(name)) {
			seen.add(name);
			failures.push(name);
		}
	}

	// Pattern 2: Node test runner "✗ description" (lines starting with ✗)
	const crossPattern = /^✗\s+(.+)$/gm;
	while ((match = crossPattern.exec(combined)) !== null) {
		const name = match[1]!.trim();
		if (name && !seen.has(name)) {
			seen.add(name);
			failures.push(name);
		}
	}

	// Pattern 3: FAIL keyword
	const failPattern = /^FAIL\s+(.+)$/gm;
	while ((match = failPattern.exec(combined)) !== null) {
		const name = match[1]!.trim();
		if (name && !seen.has(name)) {
			seen.add(name);
			failures.push(name);
		}
	}

	// Pattern 4: "# FAIL N" (subtest failure markers)
	const hashFailPattern = /^#\s+FAIL\s+\d+/gm;
	if (hashFailPattern.test(combined) && failures.length === 0) {
		// Try to extract the description from nearby lines
		const lines = combined.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (/^#\s+FAIL\s+\d+/.test(lines[i]!)) {
				// Look at the previous line for the test name
				const prev = i > 0 ? lines[i - 1] : null;
				if (prev && prev.trim() && !prev.startsWith("#") && !seen.has(prev.trim())) {
					seen.add(prev.trim());
					failures.push(prev.trim());
				}
			}
		}
	}

	// Pattern 5: AssertionError messages
	const assertPattern = /AssertionError\b[^:]*:\s*(.+)$/gm;
	while ((match = assertPattern.exec(combined)) !== null) {
		const name = match[1]!.trim();
		if (name && !seen.has(name)) {
			seen.add(name);
			failures.push(name);
		}
	}

	return failures;
}

/**
 * Truncate output to maxLines lines.
 * Returns truncated text plus a notice if truncation occurred.
 */
export function truncateOutput(
	output: string,
	maxLines: number,
): { text: string; truncated: boolean } {
	const lines = output.split("\n");
	if (lines.length <= maxLines) {
		return { text: output, truncated: false };
	}
	const truncated = lines.slice(0, maxLines).join("\n");
	return {
		text: truncated + "\n...output truncated...",
		truncated: true,
	};
}

/**
 * Extract the first fenced code block command from a comment body.
 * Handles ```bash, ```, and ```language fences.
 * Returns the inner text (trimmed) or null if no block found.
 */
export function extractTestCommand(commentBody: string): string | null {
	// Match fenced code blocks: ```optionalLanguage\n...content...\n```
	const fencePattern = /```(\w*)\n([\s\S]*?)```/g;
	let match;
	while ((match = fencePattern.exec(commentBody)) !== null) {
		const content = match[2]!.trim();
		if (content) {
			return content;
		}
	}
	return null;
}
