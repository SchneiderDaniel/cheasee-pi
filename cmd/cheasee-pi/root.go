package main

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "cheasee-pi",
	Short: "Cheasee-PI — Raspberry Pi management and monitoring",
	Long: `Cheasee-PI is a tool for managing Raspberry Pi devices
with support for Docker-based deployments, monitoring, and configuration.`,
	Version:            "0.1.0",
	DisableAutoGenTag:  true,
}
