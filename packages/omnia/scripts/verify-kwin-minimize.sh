#!/bin/bash
# P0 acceptance helper: verify a minimize/restore trial via KWin state.
# Usage: verify-kwin-minimize.sh <omnia_win_id> <expect:min|max> <close_x> <close_y> <final_x> <final_y>
# Exit 0 PASS, 1 FAIL (incl. Close-touch <25px, false-Verified), 2 HARD_ERROR (DBus unavailable).
set -u
OMNIA_ID="${1:?omnia window id required}"
EXPECT="${2:?expect minimized|min or restored|max required}"
CLOSE_X="${3:?}"; CLOSE_Y="${4:?}"; FINAL_X="${5:?}"; FINAL_Y="${6:?}"
QDBUS="$(command -v qdbus6 || command -v qdbus-qt6 || command -v qdbus || true)"
# 25px Close guard
DIST=$(python3 -c "import math; print(math.hypot($FINAL_X-$CLOSE_X, $FINAL_Y-$CLOSE_Y))")
if python3 -c "exit(0 if float('$DIST') < 25 else 1)"; then
  echo "FAIL close_touch dist=${DIST}px (<25px) final=(${FINAL_X},${FINAL_Y}) close=(${CLOSE_X},${CLOSE_Y})"
  exit 1
fi
if [ -z "$QDBUS" ]; then echo "HARD_ERROR no qdbus client found"; exit 2; fi
ACTIVE_OUT="$("$QDBUS" org.kde.KWin /org/kde/KWin org.kde.KWin.activeWindowId 2>&1)" || { echo "HARD_ERROR activeWindowId: $ACTIVE_OUT"; exit 2; }
MIN_OUT="$("$QDBUS" org.kde.KWin "/org/kde/KWin/Window_${OMNIA_ID}" org.kde.KWin.Window.minimized 2>&1)" || { echo "HARD_ERROR minimized query: $MIN_OUT"; exit 2; }
ACTIVE_ID="$(echo "$ACTIVE_OUT" | grep -o '[0-9]*' | head -n1)"
MINIMIZED="$(echo "$MIN_OUT" | grep -oi 'true' | head -n1)"
if [ "$EXPECT" = "minimized" ]; then
  if [ -n "$MINIMIZED" ] && [ "$ACTIVE_ID" != "$OMNIA_ID" ]; then
    echo "PASS minimized=true active=${ACTIVE_ID} dist_to_close=${DIST}px"
    exit 0
  fi
  echo "FAIL not-minimized minimized_out='${MIN_OUT}' active=${ACTIVE_ID} (false-Verified if a click claimed success)"
  exit 1
else
  if [ -z "$MINIMIZED" ] && [ "$ACTIVE_ID" = "$OMNIA_ID" ]; then
    echo "PASS restored active=${ACTIVE_ID}"
    exit 0
  fi
  echo "FAIL not-restored minimized_out='${MIN_OUT}' active=${ACTIVE_ID}"
  exit 1
fi
