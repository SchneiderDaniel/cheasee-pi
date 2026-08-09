/**
 * Caveman config UI — interactive SettingsList dialog
 *
 * UI at the edge — contains the full TUI dialog for caveman settings.
 * Pure helper functions (applySettingChange, cycleSelectedValue) are
 * exported for unit testing without TUI infrastructure.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { ConfigStore } from "./config.ts";
import type { Level, CavemanConfig } from "./types.ts";
import { LEVELS } from "./types.ts";

// ---------------------------------------------------------------------------
// Pure domain helpers
// ---------------------------------------------------------------------------

/**
 * Apply a setting change to the current config.
 *
 * Returns the updated config if the id/value pair is valid,
 * or null if the id is unknown or the value is rejected.
 */
export function applySettingChange(
	id: string,
	newValue: string,
	currentConfig: CavemanConfig,
): CavemanConfig | null {
	if (id === "defaultLevel") {
		if (LEVELS.includes(newValue as Level)) {
			return { ...currentConfig, defaultLevel: newValue as Level };
		}
		return null;
	}

	if (id === "showStatus") {
		return { ...currentConfig, showStatus: newValue === "on" };
	}

	return null;
}

/**
 * Calculate the next value index for cycling through a setting's values.
 *
 * @param items — list of all SettingItems in the dialog
 * @param selectedIndex — index into items for the currently selected item
 * @param direction — +1 for forward, -1 for backward
 * @returns the new index in the item's values array, or -1 if no valid cycling is possible
 */
export function cycleSelectedValue(
	items: SettingItem[],
	selectedIndex: number,
	direction: -1 | 1,
): number {
	const item = items[selectedIndex];
	if (!item?.values?.length) return -1;

	const currentIndex = item.values.indexOf(item.currentValue);
	if (currentIndex === -1) return -1;

	return (currentIndex + direction + item.values.length) % item.values.length;
}

// ---------------------------------------------------------------------------
// Config dialog
// ---------------------------------------------------------------------------

/**
 * Open the interactive caveman config dialog.
 *
 * Renders a SettingsList with defaultLevel and showStatus toggles.
 * Extracted into its own module to keep UI code separate from command dispatch.
 */
export async function openConfigDialog(
	ctx: ExtensionContext,
	configStore: ConfigStore,
	syncStatus: (ctx: Pick<ExtensionContext, "ui">) => void,
): Promise<void> {
	await configStore.ensureConfigLoaded();

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const config = configStore.getConfig();

		const items: SettingItem[] = [
			{
				id: "defaultLevel",
				label: "Default level for new sessions",
				currentValue: config.defaultLevel,
				values: [...LEVELS],
			},
			{
				id: "showStatus",
				label: "Show status bar",
				currentValue: config.showStatus ? "on" : "off",
				values: ["on", "off"],
			},
		];

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(" Caveman Config")), 0, 0));
		container.addChild(new Text(theme.fg("dim", " Saved to ~/.pi/agent/caveman.json"), 0, 0));
		container.addChild(
			new Text(theme.fg("dim", " Default level applies to future sessions."), 0, 0),
		);
		container.addChild(new Text("", 0, 0));

		const handleApply = async (id: string, newValue: string) => {
			const currentConfig = configStore.getConfig();
			const updated = applySettingChange(id, newValue, currentConfig);
			if (updated) {
				await configStore.saveConfig(updated);
				syncStatus(ctx);
			}
		};

		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 10),
			getSettingsListTheme(),
			handleApply,
			() => done(undefined),
		);

		container.addChild(settingsList);
		container.addChild(
			new Text(theme.fg("dim", " ←→/hl/tab change • ↑↓/jk move • esc close"), 0, 0),
		);

		const cycleValue = (direction: -1 | 1) => {
			const selectedIndex = (settingsList as unknown as { selectedIndex: number }).selectedIndex;
			const nextIndex = cycleSelectedValue(items, selectedIndex, direction);
			if (nextIndex === -1) return;

			const item = items[selectedIndex];
			const newValue = item.values![nextIndex]!;
			item.currentValue = newValue;
			settingsList.updateValue(item.id, newValue);
			void handleApply(item.id, newValue);
		};

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "j") data = "\u001b[B";
				else if (data === "k") data = "\u001b[A";
				else if (data === "h") {
					cycleValue(-1);
					_tui.requestRender();
					return;
				} else if (data === "l" || data === "\u001b[C" || data === "\t") {
					cycleValue(1);
					_tui.requestRender();
					return;
				} else if (data === "\u001b[D") {
					cycleValue(-1);
					_tui.requestRender();
					return;
				}

				settingsList.handleInput?.(data);
				_tui.requestRender();
			},
		};
	});
}
