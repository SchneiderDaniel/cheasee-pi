package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// The readers: both settings files plus pi's undecoded `packages` array.

// loadCheaseeSettingsIfPresent loads cheasee-settings.json, reporting whether it
// existed. A missing file is not an error: the retirement still has to clean
// `.pi/settings.json`, and it must never create the workspace marker.
func loadCheaseeSettingsIfPresent(root string) (*CheaseeSettings, bool, error) {
	settings, err := LoadCheaseeSettings(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return settings, true, nil
}

// loadPISettingsIfPresent loads `.pi/settings.json`, reporting whether it
// existed. pi self-scaffolds that file, so its absence simply means there is
// nothing registered yet.
func loadPISettingsIfPresent(root string) (*Settings, bool, error) {
	settings, err := LoadSettings(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return settings, true, nil
}

// piPackages returns the raw elements of `.pi/settings.json`'s `packages`
// array. The key is not a typed Settings field — pi owns it — so it is read out
// of the unknown-key map and stays undecoded, which is what keeps unrelated
// entries byte-for-byte intact.
func piPackages(settings *Settings) ([]json.RawMessage, error) {
	if settings == nil {
		return nil, nil
	}
	raw, ok := settings.extra["packages"]
	if !ok {
		return nil, nil
	}
	var elems []json.RawMessage
	if err := json.Unmarshal(raw, &elems); err != nil {
		return nil, fmt.Errorf(".pi/settings.json: `packages` is not a JSON array: %w", err)
	}
	return elems, nil
}
