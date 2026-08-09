import type { Component } from "@earendil-works/pi-tui";

/**
 * Signature for a single eventType renderer.
 * `cwd` is optional — only tool-call rendering (relative path display) needs it.
 * Renderers are pure: no `pi`, no side effects beyond returning a component.
 */
export type RendererFn = (message: any, options: any, theme: any, cwd?: string) => Component;
