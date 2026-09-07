#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux ]]
mkdir -p test-results/nested-wayland
export ORCA_NESTED_EVIDENCE="$RUNNER_TEMP/orca-nested-wayland-evidence"
mkdir -p "$ORCA_NESTED_EVIDENCE"
export XDG_RUNTIME_DIR="$RUNNER_TEMP/orca-wayland-runtime"
mkdir -m 700 -p "$XDG_RUNTIME_DIR"
export WAYLAND_DISPLAY=wayland-orca-deflake
export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=GNOME
export LIBGL_ALWAYS_SOFTWARE=1
export NO_AT_BRIDGE=1
export GTK_IM_MODULE=ibus
export QT_IM_MODULE=ibus
export XMODIFIERS=@im=ibus
export IBUS_ENABLE_SYNC_MODE=1
export ORCA_E2E_NESTED_FOCUS_CMD="$RUNNER_TEMP/orca-focus-nested.sh"
cat > "$ORCA_E2E_NESTED_FOCUS_CMD" <<'FOCUS'
#!/usr/bin/env bash
set -euo pipefail
exec 2>> "$ORCA_NESTED_EVIDENCE/focus.log"
set -x
printf 'Display: %s\n' "$DISPLAY" >&2
mapfile -t windows < <(xwininfo -root -tree | awk '$2 == "\"gnome-shell\":" {print $1}')
printf 'Compositor candidates: %s\n' "${windows[*]}" >&2
for candidate in "${windows[@]}"; do xwininfo -id "$candidate" >&2; done
[[ ${#windows[@]} -eq 1 ]]
xdotool windowmap --sync "${windows[0]}"
xdotool windowfocus --sync "${windows[0]}"
read -r width height < <(xwininfo -id "${windows[0]}" | awk '$1 == "Width:" {w=$2} $1 == "Height:" {print w,$2}')
xdotool mousemove --window "${windows[0]}" "$((width / 2))" "$((height / 2))" click 1
FOCUS
chmod +x "$ORCA_E2E_NESTED_FOCUS_CMD"
gsettings set org.freedesktop.ibus.engine.hangul initial-input-mode hangul
gsettings set org.freedesktop.ibus.engine.hangul hangul-keyboard 2
gsettings set org.gnome.desktop.interface enable-animations false
gsettings set org.gnome.desktop.input-sources sources "[('ibus', 'hangul')]"
setsid gnome-shell --nested --wayland --wayland-display="$WAYLAND_DISPLAY" > "$ORCA_NESTED_EVIDENCE/gnome-shell.log" 2>&1 &
compositor_pid=$!
cleanup() {
  xwininfo -root -tree > test-results/nested-wayland/x-window-tree.txt 2>&1 || true
  kill -TERM -- "-$compositor_pid" 2>/dev/null || true
  wait "$compositor_pid" 2>/dev/null || true
  mkdir -p test-results/nested-wayland
  cp -a "$ORCA_NESTED_EVIDENCE/." test-results/nested-wayland/
}
trap cleanup EXIT
for attempt in {1..100}; do
  kill -0 "$compositor_pid"
  [[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]] && break
  sleep 0.1
done
[[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]]
ibus-daemon --daemonize --xim --replace --verbose > "$ORCA_NESTED_EVIDENCE/ibus-daemon.log" 2>&1
for attempt in {1..100}; do
  if ibus engine hangul; then break; fi
  sleep 0.1
done
[[ "$(ibus engine)" == hangul ]]
xwininfo -root -tree > "$ORCA_NESTED_EVIDENCE/x-window-tree-before.txt"
export ORCA_E2E_NATIVE_IBUS_HANGUL=1
export ORCA_E2E_IME_INJECTOR=nested
export ORCA_E2E_FOREGROUND=1
export ORCA_E2E_EXTRA_APP_ARGS='--ozone-platform=wayland --enable-wayland-ime --wayland-text-input-version=3 --password-store=basic --use-mock-keychain --disable-gpu-sandbox'
export ORCA_E2E_IME_ENGAGEMENT_RECEIPT="$PWD/test-results/nested-wayland/ime-engagement.jsonl"
export PLAYWRIGHT_JSON_OUTPUT_FILE=test-results/nested-wayland/playwright.json
export SKIP_BUILD=1
export ORCA_E2E_FORWARD_APP_LOGS=1
pnpm exec playwright test --config tests/playwright.config.ts tests/e2e/terminal-hangul-terminating-digit-native.spec.ts --project=electron-headful --workers=1 --retries=0 --reporter=list,json
node --input-type=module <<'VERIFY'
import { readFileSync } from 'node:fs'
import { verifyImeEngagementReceipts } from './config/scripts/terminal-ime-engagement-receipt.mjs'
import { verifyPlaywrightParticipation } from './config/scripts/verify-playwright-participation.mjs'
const title = 'a digit typed right after a Hangul syllable reaches the pty'
verifyPlaywrightParticipation(JSON.parse(readFileSync('test-results/nested-wayland/playwright.json','utf8')), {titles:[title],label:'Nested Wayland',repetitions:1})
const problems=verifyImeEngagementReceipts(readFileSync(process.env.ORCA_E2E_IME_ENGAGEMENT_RECEIPT,'utf8'),[title])
if(problems.length) throw new Error(problems.join('\n'))
console.log('Verified exact scenario participation and native Hangul composition engagement')
VERIFY
