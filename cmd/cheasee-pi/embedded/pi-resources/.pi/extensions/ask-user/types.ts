/**
 * ask-user — shared types
 *
 * Domain-facing interfaces and TypeBox schema for the ask_user tool.
 * Zero runtime logic beyond TypeBox schema builders.
 */

import { type TUnsafe, Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Mode of questioning: multiple-choice or free-text. */
export type Mode = "choice" | "freetext";

/** A single option in a choice question. */
export interface OptionItem {
	label: string;
	value: string;
	recommended?: boolean;
}

/** Internal label→value pair for mapping display labels back to values. */
export interface LabelValuePair {
	label: string;
	value: string;
}

// ---------------------------------------------------------------------------
// Q&A storage types
// ---------------------------------------------------------------------------

/** A single Q&A entry stored in JSONL. */
export interface QnaEntry {
	datetime: string;
	question: string;
	answer: string;
}

/**
 * Schema for the ask_user_read tool parameters.
 * Uses TypeBox for runtime validation.
 */
export const QnaReadParams = Type.Object({
	action: StringEnum(["list", "get", "query"] as const, {
		description: "Action to perform: list, get, or query",
	}),
	limit: Type.Optional(
		Type.Number({
			description: "Number of entries to return (default 20, used with list action)",
			default: 20,
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "1-based line number of the entry (used with get action)",
		}),
	),
	text: Type.Optional(
		Type.String({
			description: "Search text for query action (case-insensitive search in question and answer)",
		}),
	),
});

// ---------------------------------------------------------------------------
// TypeBox schemas
// ---------------------------------------------------------------------------

/**
 * Schema for the `mode` parameter — uses StringEnum for provider
 * compatibility (fixes P14: Type.Union → StringEnum).
 */
const QuestionMode: TUnsafe<Mode> = StringEnum(["choice", "freetext"] as const, {
	description: "Question mode: 'choice' for multiple-choice, 'freetext' for open-ended input",
	default: "choice",
});

/** Full parameter schema for the ask_user tool. */
export const QuestionParams = Type.Object({
	mode: Type.Optional(QuestionMode),
	question: Type.String({
		description:
			"The question to display to the user. Include enough context that the user can answer without scrolling up.",
	}),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String({
					description: "The option text shown to the user",
				}),
				value: Type.String({
					description:
						"Short value returned when this option is selected (e.g. 'yes_noop', 'keep_as_is')",
				}),
				recommended: Type.Optional(
					Type.Boolean({
						description: "Set to true for exactly ONE option to mark it as 'Recommended'",
					}),
				),
			}),
			{
				description:
					"Answer options (required for choice mode, ignored in freetext mode). Must have at least 3 options. One must have recommended=true. 'Other' is added automatically unless disableOther is true.",
			},
		),
	),
	disableOther: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to suppress the automatic 'Other' option. Use for quizzes or when only predefined choices are accepted.",
		}),
	),
});
