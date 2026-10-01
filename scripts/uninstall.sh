#!/bin/sh
# Stops and removes the launch agent. The cloned folder is left alone.
set -eu

LABEL="xyz.xr7uz.apple-music-discord-rpc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$HOME/Library/Caches/apple-music-discord-rpc"

printf '\033[32m✓\033[0m uninstalled\n'
