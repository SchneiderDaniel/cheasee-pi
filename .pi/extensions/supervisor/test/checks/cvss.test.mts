// ─── CVSS arithmetic + severity vocabulary (issue #2033 split) ──────
// `checks/cvss.ts` is pure arithmetic (no I/O); `checks/cvss-severity.ts` owns
// the vocabulary mapping. Both were carved out of `osv-severity.ts`, which
// keeps the OSV JSON → finding mapping.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cvss3BaseScore, roundupToTenth } from "../../checks/cvss.ts";
import { mapSeverityString, severityFromBaseScore } from "../../checks/cvss-severity.ts";

describe("cvss3BaseScore", () => {
	it("scores the canonical v3.1 vector", () => {
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), 9.8);
	});

	it("scores an all-zero impact vector as 0", () => {
		// `===`, not `strictEqual`: the rounding step yields -0 here, which is 0.
		assert.ok(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N") === 0);
	});

	it("returns null for a bare number and for a v4 vector", () => {
		assert.equal(cvss3BaseScore("9.8"), null);
		assert.equal(cvss3BaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H"), null);
	});

	it("returns null for a duplicated metric key", () => {
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/AV:N"), null);
	});

	it("returns null for an unknown metric or value", () => {
		assert.equal(cvss3BaseScore("CVSS:3.1/ZZZ:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), null);
	});

	it("ignores optional trailing temporal metrics", () => {
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:H"), 9.8);
	});
});

describe("roundupToTenth", () => {
	it("rounds up, never down, to one decimal", () => {
		assert.equal(roundupToTenth(8.9), 8.9);
		assert.equal(roundupToTenth(6.04), 6.1);
		assert.ok(roundupToTenth(6.04) >= 6.04);
		assert.equal(Math.round(roundupToTenth(7.123) * 10) / 10, roundupToTenth(7.123));
	});
});

describe("mapSeverityString", () => {
	it("maps every known vocabulary", () => {
		assert.equal(mapSeverityString("CRITICAL"), "CRITICAL");
		assert.equal(mapSeverityString("HIGH"), "HIGH");
		assert.equal(mapSeverityString("MODERATE"), "MEDIUM");
		assert.equal(mapSeverityString("MEDIUM"), "MEDIUM");
		assert.equal(mapSeverityString("LOW"), "LOW");
	});

	it("fails closed to UNKNOWN", () => {
		assert.equal(mapSeverityString("nonsense"), "UNKNOWN");
		assert.equal(mapSeverityString(""), "UNKNOWN");
		assert.equal(mapSeverityString(undefined), "UNKNOWN");
	});
});

describe("severityFromBaseScore", () => {
	it("uses the CVSS v3.1 qualitative bands", () => {
		assert.equal(severityFromBaseScore(9.0), "CRITICAL");
		assert.equal(severityFromBaseScore(8.9), "HIGH");
		assert.equal(severityFromBaseScore(7.0), "HIGH");
		assert.equal(severityFromBaseScore(6.9), "MEDIUM");
		assert.equal(severityFromBaseScore(4.0), "MEDIUM");
		assert.equal(severityFromBaseScore(3.9), "LOW");
	});

	it("returns null below the lowest band", () => {
		assert.equal(severityFromBaseScore(0), null);
	});
});
