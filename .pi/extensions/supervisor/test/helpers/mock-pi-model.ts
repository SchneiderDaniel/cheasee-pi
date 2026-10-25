/**
 * mock-pi-model.ts — mock `ModelRegistry`.
 *
 * Split out of mock-pi.ts (issue #2036); `mock-pi.ts` re-exports it.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export function createMockModelRegistry(): ModelRegistry {
	// ModelRegistry is a class with many methods. Tests rarely interact
	// with it directly, so provide a minimal proxy.
	return {
		getModel: () => undefined,
		getAllModels: () => [],
		getProviderModels: () => [],
	} as unknown as ModelRegistry;
}
