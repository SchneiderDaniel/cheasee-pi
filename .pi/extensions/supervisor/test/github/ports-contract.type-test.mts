// ─── Type gate: github/ports.ts sub-port contract (issue #2098) ──
// tsc-only file (NOT run by the test runner — the glob only picks *.test.mts).
// It pins that GitHubPort is exactly the intersection of its sub-ports, so a
// use case typed against the whole port can never drift from the composition
// root's wiring contract.

import type { AuthPort, GitHubPort, IssuePort, ProjectPort, PullPort } from "../../github/ports.ts";

type SubPorts = IssuePort & PullPort & ProjectPort & AuthPort;

declare const whole: GitHubPort;
declare const parts: SubPorts;

// Bidirectional assignability: neither side may grow a member the other lacks.
const _wholeToParts: SubPorts = whole;
const _partsToWhole: GitHubPort = parts;

const complete: GitHubPort = {} as GitHubPort;

// A port missing a project method is NOT a GitHubPort.
const { getProjectItems: _omittedProjectItems, ...withoutProjectItems } = complete;
// @ts-expect-error — getProjectItems is required by ProjectPort
const _missingProjectItems: GitHubPort = withoutProjectItems;

// A port missing a pull method is NOT a GitHubPort either.
const { compareBranches: _omittedCompareBranches, ...withoutCompare } = complete;
// @ts-expect-error — compareBranches is required by PullPort
const _missingCompareBranches: GitHubPort = withoutCompare;

// A port missing the token lifecycle is NOT a GitHubPort.
const { setToken: _omittedSetToken, ...withoutSetToken } = complete;
// @ts-expect-error — setToken is required by AuthPort
const _missingSetToken: GitHubPort = withoutSetToken;

export {};
