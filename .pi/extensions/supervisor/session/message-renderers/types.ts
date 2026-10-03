import type { Component } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";

/**
 * Minimal details shape the dispatcher needs. Payload fields vary per
 * `eventType`; renderer bodies narrow their own reads. This deliberately does
 * not model the six producer payload shapes — a single shared interface
 * covering unrelated fields would be a lie.
 */
export interface SupervisorDetails {
	eventType?: string;
	[key: string]: unknown;
}

/**
 * Signature for a single eventType renderer, derived from pi's exported
 * `MessageRenderer` contract so the dispatch table can never drift from it.
 * `cwd` is optional — only tool-call rendering (relative path display) needs it.
 * Renderers are pure: no `pi`, no side effects beyond returning a component.
 */
export type RendererFn = (
	message: Parameters<MessageRenderer<SupervisorDetails>>[0],
	options: Parameters<MessageRenderer<SupervisorDetails>>[1],
	theme: Parameters<MessageRenderer<SupervisorDetails>>[2],
	cwd?: string,
) => Component | undefined;
