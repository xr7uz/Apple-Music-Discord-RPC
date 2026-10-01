#!/bin/sh
# Installs (or updates) the launch agent so the presence starts at login.
set -eu

LABEL="xyz.xr7uz.apple-music-discord-rpc"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/apple-music-discord-rpc.log"

step() { printf '\033[35m›\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "macOS only"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "node not found, install Node.js 22.18+ first (brew install node)"
"$NODE" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1);
' || fail "Node.js 22.18+ required, found $("$NODE" --version)"
# resolve symlinks (Homebrew, nvm) so launchd gets a real path
NODE="$("$NODE" -p 'require("node:fs").realpathSync(process.execPath)')"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

step "stopping previous agent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

step "writing $PLIST"
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>--env-file-if-exists=$(xml "$ROOT/.env")</string>
    <string>$(xml "$ROOT/src/main.ts")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$LOG")</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null || fail "generated plist is invalid"

step "starting agent"
# bootout finishes asynchronously, so give launchd a moment if it is still busy
tries=0
until launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 5 ] || launchctl bootstrap "gui/$(id -u)" "$PLIST" || fail "launchctl bootstrap failed"
  [ "$tries" -lt 5 ] || break
  sleep 1
done

printf '\033[32m✓\033[0m installed — logs: tail -f %s\n' "$LOG"
echo "  first run: allow \"node\" to control Music and System Events when macOS asks"
