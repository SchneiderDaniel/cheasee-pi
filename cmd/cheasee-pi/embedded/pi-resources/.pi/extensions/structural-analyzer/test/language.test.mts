/**
 * Tests: language.ts — language detection & YAML parsing
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { fileExists, detectLanguage, parseLanguageGlobsFromYaml } from "../language.ts";

describe("parseLanguageGlobsFromYaml", () => {
	it("extracts first key from languageGlobs section", () => {
		const yaml = `\
rules:
  - id: test
languageGlobs:
  ts: "**/*.ts"
  js: "**/*.js"
`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), "ts");
	});

	it("returns null when no languageGlobs section", () => {
		const yaml = `\
rules:
  - id: test
`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), null);
	});

	it("returns null for empty string", () => {
		assert.strictEqual(parseLanguageGlobsFromYaml(""), null);
	});

	it('unquotes double-quoted key "ts" → ts', () => {
		const yaml = `\
languageGlobs:
  "ts": "glob"
  js: "glob"
`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), "ts");
	});

	it("unquotes single-quoted key 'py' → py", () => {
		const yaml = `\
languageGlobs:
  'py': "glob"
`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), "py");
	});

	it("mixed quoted first key / unquoted second key → first key unquoted", () => {
		const yaml = `\
languageGlobs:
  "rust": "*.rs"
  js: "*.js"
`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), "rust");
	});

	it('malformed leading quote "ts: returns unchanged', () => {
		const yaml = `\
languageGlobs:
  "ts: "glob"
`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), '"ts');
	});

	it('malformed trailing quote ts": returns unchanged', () => {
		const yaml = `\
languageGlobs:
  ts": "glob"
`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), 'ts"');
	});

	it('empty quoted key "": returns empty string', () => {
		const yaml = `\
languageGlobs:
  "": "glob"
`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), "");
	});

	it("stops at unindented top-level key after languageGlobs", () => {
		const yaml = `\
languageGlobs:
  ts: "*.ts"
rules:
  - id: test
`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), "ts");
	});
});

describe("fileExists", () => {
	it("returns true when exec code is 0", async () => {
		const mockExec = async (_cmd: string, _args: string[], _opts?: { cwd?: string }) => {
			return { code: 0 };
		};
		assert.strictEqual(await fileExists(mockExec, "tsconfig.json", "/p"), true);
	});

	it("returns false when exec code is 1", async () => {
		const mockExec = async (_cmd: string, _args: string[], _opts?: { cwd?: string }) => {
			return { code: 1 };
		};
		assert.strictEqual(await fileExists(mockExec, "nonexistent.json", "/p"), false);
	});
});

describe("CONFIG_PRIORITY export removal", () => {
	it("is not exported from the module", async () => {
		// Dynamic import to inspect the module's export surface
		const mod: Record<string, unknown> = await import("../language.ts");
		assert.strictEqual(
			"CONFIG_PRIORITY" in mod,
			false,
			"CONFIG_PRIORITY should not be a public export — it is only used internally by detectLanguage()",
		);
	});
});

describe("detectLanguage", () => {
	it("returns 'typescript' when tsconfig.json exists", async () => {
		let callCount = 0;
		const mockExec = async (_cmd: string, _args: string[], _opts?: { cwd?: string }) => {
			callCount++;
			if (_args[0] === "-f") {
				// Check which file is being tested
				if (_args[1] === "tsconfig.json") return { code: 0, stdout: "" };
				return { code: 1, stdout: "" };
			}
			return { code: 0, stdout: "" };
		};
		assert.strictEqual(await detectLanguage(mockExec, "/p"), "typescript");
	});

	it("returns 'python' when pyproject.toml exists", async () => {
		const mockExec = async (_cmd: string, _args: string[], _opts?: { cwd?: string }) => {
			if (_args[0] === "-f") {
				if (_args[1] === "pyproject.toml") return { code: 0, stdout: "" };
				return { code: 1, stdout: "" };
			}
			return { code: 0, stdout: "" };
		};
		assert.strictEqual(await detectLanguage(mockExec, "/p"), "python");
	});

	it("returns 'go' when go.mod exists", async () => {
		const mockExec = async (_cmd: string, _args: string[], _opts?: { cwd?: string }) => {
			if (_args[0] === "-f") {
				if (_args[1] === "go.mod") return { code: 0, stdout: "" };
				return { code: 1, stdout: "" };
			}
			return { code: 0, stdout: "" };
		};
		assert.strictEqual(await detectLanguage(mockExec, "/p"), "go");
	});

	it("returns 'rust' when Cargo.toml exists", async () => {
		const mockExec = async (_cmd: string, _args: string[], _opts?: { cwd?: string }) => {
			if (_args[0] === "-f") {
				if (_args[1] === "Cargo.toml") return { code: 0, stdout: "" };
				return { code: 1, stdout: "" };
			}
			return { code: 0, stdout: "" };
		};
		assert.strictEqual(await detectLanguage(mockExec, "/p"), "rust");
	});

	it("returns null when no config files exist", async () => {
		const mockExec = async (_cmd: string, _args: string[], _opts?: { cwd?: string }) => {
			return { code: 1, stdout: "" };
		};
		assert.strictEqual(await detectLanguage(mockExec, "/p"), null);
	});

	it("sgconfig.yml takes priority over tsconfig.json", async () => {
		const mockExec = async (cmd: string, _args: string[], _opts?: { cwd?: string }) => {
			if (_args[0] === "-f") {
				// Both exist, sgconfig checked first
				return { code: 0, stdout: "" };
			}
			if (cmd === "cat") {
				return { code: 0, stdout: "languageGlobs:\n  rust: '*.rs'\n" };
			}
			return { code: 0, stdout: "" };
		};
		assert.strictEqual(await detectLanguage(mockExec, "/p"), "rust");
	});

	it("sgconfig.yml with empty languageGlobs falls through to tsconfig.json", async () => {
		let testCallCount = 0;
		const mockExec = async (cmd: string, _args: string[], _opts?: { cwd?: string }) => {
			testCallCount++;
			if (_args[0] === "-f") {
				// Both exist
				return { code: 0, stdout: "" };
			}
			if (cmd === "cat") {
				// sgconfig with no languageGlobs
				return { code: 0, stdout: "rules:\n  - id: test\n" };
			}
			return { code: 0, stdout: "" };
		};
		assert.strictEqual(await detectLanguage(mockExec, "/p"), "typescript");
	});

	it("detects from sgconfig.yml with quoted keys", async () => {
		const mockExec = async (cmd: string, _args: string[], _opts?: { cwd?: string }) => {
			if (_args[0] === "-f") {
				return { code: 0, stdout: "" };
			}
			if (cmd === "cat") {
				return { code: 0, stdout: 'languageGlobs:\n  "py": "*.py"\n' };
			}
			return { code: 0, stdout: "" };
		};
		assert.strictEqual(await detectLanguage(mockExec, "/p"), "py");
	});
});
