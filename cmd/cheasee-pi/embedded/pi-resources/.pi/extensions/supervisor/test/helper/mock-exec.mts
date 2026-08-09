/**
 * Mock execSync wrapper for unit-testing Auditor test execution.
 *
 * In unit tests, Auditor logic that shells out should be testable
 * without real command execution. This module provides a mock that
 * simulates success, failure, timeout, and error conditions.
 */

import { execSync } from "node:child_process";

export interface ExecResult {
	stdout: string;
	stderr: string;
	success: boolean;
	exitCode: number;
}

export interface ExecOptions {
	timeout?: number;
	cwd?: string;
}

/**
 * Execute a command and return structured result.
 * Wraps execSync so callers can mock this function in tests.
 */
export function runCommand(command: string, options: ExecOptions = {}): ExecResult {
	try {
		const stdout = execSync(command, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: (options.timeout || 60) * 1000,
			cwd: options.cwd,
		});
		return {
			stdout: stdout || "",
			stderr: "",
			success: true,
			exitCode: 0,
		};
	} catch (err: any) {
		return {
			stdout: err.stdout?.toString() || "",
			stderr: err.stderr?.toString() || err.message || "",
			success: false,
			exitCode: err.status || err.exitCode || 1,
		};
	}
}

/**
 * Create a mock runCommand that returns a fixed result.
 * Returns a function matching the runCommand signature.
 */
export function mockRunCommand(result: ExecResult): typeof runCommand {
	return (_command: string, _options?: ExecOptions): ExecResult => {
		return { ...result };
	};
}

/**
 * Create a mock runCommand factory that returns different results
 * based on the command string. Useful for testing multiple scenarios.
 */
export function mockRunCommandFactory(handler: (command: string) => ExecResult): typeof runCommand {
	return (command: string, _options?: ExecOptions): ExecResult => {
		return handler(command);
	};
}
