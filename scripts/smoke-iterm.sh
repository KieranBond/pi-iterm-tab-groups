#!/usr/bin/env bash
set -euo pipefail

if ! osascript -e 'tell application "iTerm2" to count windows' >/dev/null 2>&1; then
  echo "iTerm2 must be running for this smoke test." >&2
  exit 1
fi
if ! command -v pi >/dev/null 2>&1; then
  echo "pi must be on PATH for this smoke test." >&2
  exit 1
fi

run_id="$(date +%s)"
group="Tab Smoke ${run_id}"
base_dir="/tmp/pi-iterm-tab-groups-smoke-${run_id}"
session_ids=()

write_session() {
  local session_id="$1"
  local text="$2"
  osascript - "$session_id" "$text" <<'APPLESCRIPT' >/dev/null
on run argv
  set targetId to item 1 of argv
  set commandText to item 2 of argv
  tell application "iTerm2"
    repeat with targetWindow in windows
      repeat with targetTab in tabs of targetWindow
        repeat with targetSession in sessions of targetTab
          if (id of targetSession as text) is targetId then
            tell targetSession to write text commandText
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "iTerm2 session not found: " & targetId
end run
APPLESCRIPT
}

session_name() {
  local session_id="$1"
  osascript - "$session_id" <<'APPLESCRIPT'
on run argv
  set targetId to item 1 of argv
  tell application "iTerm2"
    repeat with targetWindow in windows
      repeat with targetTab in tabs of targetWindow
        repeat with targetSession in sessions of targetTab
          if (id of targetSession as text) is targetId then return name of targetSession
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run
APPLESCRIPT
}

session_exists() {
  [[ -n "$(session_name "$1")" ]]
}

wait_for_group_titles() {
  local attempt session_id name all_grouped
  for attempt in {1..60}; do
    all_grouped=1
    for session_id in "${session_ids[@]}"; do
      name="$(session_name "$session_id")"
      [[ "$name" == *"[$group]"* ]] || all_grouped=0
    done
    (( all_grouped == 1 )) && return 0
    sleep 0.5
  done
  echo "Timed out waiting for coordinated titles:" >&2
  for session_id in "${session_ids[@]}"; do
    echo "  ${session_id}: $(session_name "$session_id")" >&2
  done
  return 1
}

cleanup() {
  local session_id
  set +e
  # `exec pi` makes /quit terminate the terminal session. Never issue an
  # AppleScript close command: it can leave an off-screen confirmation sheet
  # that blocks iTerm's tab bar and menus.
  for session_id in "${session_ids[@]}"; do
    write_session "$session_id" "/quit" >/dev/null 2>&1
  done
  for _ in {1..20}; do
    local remaining=0
    for session_id in "${session_ids[@]}"; do
      session_exists "$session_id" && remaining=$((remaining + 1))
    done
    (( remaining == 0 )) && break
    sleep 0.5
  done
  rm -rf "$base_dir"
}
trap cleanup EXIT INT TERM

mkdir -p "$base_dir"/{a,b,c}
result="$(osascript - "$base_dir" <<'APPLESCRIPT'
on run argv
  set baseDir to item 1 of argv
  tell application "iTerm2"
    activate
    set smokeWindow to (create window with default profile)
    set sessionA to current session of smokeWindow
    tell sessionA to write text "cd " & quoted form of (baseDir & "/a") & " && exec pi --no-session --name TAB-SMOKE-A"

    set tabB to (create tab with default profile of smokeWindow)
    set sessionB to current session of tabB
    tell sessionB to write text "cd " & quoted form of (baseDir & "/b") & " && exec pi --no-session --name TAB-SMOKE-B"

    set tabC to (create tab with default profile of smokeWindow)
    set sessionC to current session of tabC
    tell sessionC to write text "cd " & quoted form of (baseDir & "/c") & " && exec pi --no-session --name TAB-SMOKE-C"

    return (id of sessionA as text) & "|" & (id of sessionB as text) & "|" & (id of sessionC as text)
  end tell
end run
APPLESCRIPT
)"
IFS='|' read -r -a session_ids <<<"$result"
if [[ "${#session_ids[@]}" -ne 3 ]]; then
  echo "Failed to create three iTerm sessions." >&2
  exit 1
fi

sleep 10
for session_id in "${session_ids[@]}"; do
  write_session "$session_id" "/tab-group join $group"
done
wait_for_group_titles
for session_id in "${session_ids[@]}"; do
  write_session "$session_id" "/tab-group auto"
done
sleep 3
wait_for_group_titles
write_session "${session_ids[0]}" "/tab-group refresh --all"
wait_for_group_titles

echo "PASS: three iTerm tabs coordinated on '${group}' and completed a fleet refresh."
