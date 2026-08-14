// ─── Structured Audit Extraction ─────────────────────────────────
// Text-marker / heading fallback for structured audit output, plus the
// trailing-metadata stripper shared with output.ts. Leaf module — must
// never import from output.ts (ESM cycle risk); output.ts imports from here.

export interface StructuredAuditOutput {
	decision: "APPROVED" | "REJECTED";
	prTitle?: string;
	prBody?: string;
	commentBody?: string;
}

/**
 * Strip trailing JSON blocks, thinking text, and instrumentation metadata
 * from a markdown slice.
 */
function stripTraditionalJsonEnd(
	slice: string,
	minHeadingLen: number,
	truncatePos: number,
): number {
	const jsonEndRe = /\n\s*"(?:auditScore|findings|action)"\s*:/;
	const jsonMatch = slice.match(jsonEndRe);
	if (jsonMatch?.index && jsonMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, jsonMatch.index);
	}
	return truncatePos;
}

export function stripTrailingMetadata(slice: string, minHeadingLen: number): string {
	let truncatePos = slice.length;

	truncatePos = stripTraditionalJsonEnd(slice, minHeadingLen, truncatePos);

	const thinkEndRe = /\n\u{1F4AD}/u;
	const instrEndRe = /\n\u{1F4CA}/u;
	const thinkMatch = slice.match(thinkEndRe);
	if (thinkMatch?.index && thinkMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, thinkMatch.index);
	}
	const instrMatch = slice.match(instrEndRe);
	if (instrMatch?.index && instrMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, instrMatch.index);
	}

	const ndjsonLineRe = /\n\{\s*"(?:type|role)"\s*:/;
	const ndjsonMatch = slice.match(ndjsonLineRe);
	if (ndjsonMatch?.index && ndjsonMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, ndjsonMatch.index);
	}

	const agentEndRe = /\n\s*"willRetry"\s*:/;
	const agentEndMatch = slice.match(agentEndRe);
	if (agentEndMatch?.index && agentEndMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, agentEndMatch.index);
	}

	const messagesRe = /\n\s*"messages"\s*:\s*\[/;
	const messagesMatch = slice.match(messagesRe);
	if (messagesMatch?.index && messagesMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, messagesMatch.index);
	}

	if (truncatePos < slice.length) {
		const trimmed = slice.slice(0, truncatePos).trim();
		if (trimmed.length > minHeadingLen + 20) {
			return trimmed;
		}
	}
	return slice;
}

/**
 * Extract structured audit output from text markers (AUDIT_DECISION,
 * AUDIT_APPROVED/AUDIT_REJECTED, PR_TITLE/PR_BODY/COMMENT_BODY) and the
 * `## Audit Approved/Rejected` heading fallback. Returns null when no
 * marker or heading is present. Used as the text-marker fallback by
 * output.ts's `extractStructuredAuditOutput` after the parse-first
 * strategy fails.
 */
export function extractStructuredAuditMarkers(output: string): StructuredAuditOutput | null {
	// Text marker detection
	const decisionMatch = output.match(/AUDIT_DECISION\s*:\s*(APPROVED|REJECTED)/g);
	const standaloneApproved = output.match(/\bAUDIT_APPROVED\b/g);
	const standaloneRejected = output.match(/\bAUDIT_REJECTED\b/g);

	if (!decisionMatch && !standaloneApproved && !standaloneRejected) {
		const approvedHeading = "## Audit Approved";
		const rejectedHeading = "## Audit Rejected";
		const approvedIdx = output.lastIndexOf(approvedHeading);
		const rejectedIdx = output.lastIndexOf(rejectedHeading);

		if (approvedIdx !== -1 || rejectedIdx !== -1) {
			let decision: "APPROVED" | "REJECTED";
			let heading: string;
			let bodyStart: number;

			if (approvedIdx > rejectedIdx) {
				decision = "APPROVED";
				heading = approvedHeading;
				bodyStart = approvedIdx;
			} else {
				decision = "REJECTED";
				heading = rejectedHeading;
				bodyStart = rejectedIdx;
			}

			let slice = output.slice(bodyStart).trim();
			slice = stripTrailingMetadata(slice, heading.length);

			const lastJsonFence = slice.lastIndexOf("\n\`\`\`json");
			if (lastJsonFence > heading.length + 20) {
				const beforeFence = slice.slice(0, lastJsonFence).trim();
				if (beforeFence.length > heading.length + 20) {
					slice = beforeFence;
				}
			}

			if (slice.length > heading.length + 20) {
				return { decision, commentBody: slice };
			}
		}

		return null;
	}

	let decision: "APPROVED" | "REJECTED";
	if (decisionMatch && decisionMatch.length > 0) {
		const lastDecision = decisionMatch[decisionMatch.length - 1];
		decision = lastDecision.includes("APPROVED") ? ("APPROVED" as const) : ("REJECTED" as const);
	} else if (standaloneApproved && standaloneApproved.length > 0) {
		const lastStandalone = standaloneApproved[standaloneApproved.length - 1];
		const approvedIdx = output.lastIndexOf(lastStandalone);
		const rejectedIdx = standaloneRejected
			? output.lastIndexOf(standaloneRejected[standaloneRejected.length - 1])
			: -1;
		decision = approvedIdx > rejectedIdx ? "APPROVED" : "REJECTED";
	} else {
		decision = "REJECTED";
	}

	const result: StructuredAuditOutput = { decision };

	const prTitleMatch = output.match(/PR_TITLE\s*:\s*(.+)$/gm);
	if (prTitleMatch) {
		result.prTitle = prTitleMatch[prTitleMatch.length - 1].replace(/^PR_TITLE\s*:\s*/i, "").trim();
	}

	const prBodyMatch = output.match(
		/PR_BODY\s*:[^\S\n]*([\s\S]*?)(?=\n(?:COMMENT_BODY|PR_TITLE)\s*:|$)/,
	);
	if (prBodyMatch) {
		result.prBody = prBodyMatch[1].trim();
	}

	const commentBodyMatch = output.match(
		/COMMENT_BODY\s*:[^\S\n]*([\s\S]*?)(?=\n(?:AUDIT_DECISION)\s*:|$)/,
	);
	if (commentBodyMatch) {
		let body = commentBodyMatch[1].trim();
		const bodyEndIdx = body.lastIndexOf("COMMENT_BODY_END");
		if (bodyEndIdx !== -1) {
			body = body.slice(0, bodyEndIdx).trim();
		}
		result.commentBody = body;
	}

	return result;
}
