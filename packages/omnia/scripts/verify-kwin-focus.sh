#!/usr/bin/env bash
#
# verify-kwin-focus.sh — verify a titled window-focus trial with two gates.
#
# Gates:
#   (1) wrong-target guard: FAIL if the clicked point (final_x, final_y) is
#       within 25px of the screen center while the target center
#       (target_cx, target_cy) is >150px away (from the screen center or from
#       the clicked point). Catches center-click fallbacks that missed a far
#       target.
#   (2) activeWindow==target: PASS only when the post-action active window
#       title case-insensitively substring-matches the expected title
#       (expected contained in active, case-insensitive).
#
# Usage:
#   verify-kwin-focus.sh <expected_title> <final_x> <final_y> \
#       [screen_w screen_h] [target_cx target_cy] [active_title]
#
#   If active_title is missing (or blank), an xprop fallback is attempted
#   (_NET_ACTIVE_WINDOW + _NET_WM_NAME / WM_NAME). If still missing, FAIL.
#
# Exits:
#   0 PASS, 1 FAIL, 2 HARD_ERROR (usage / non-numeric coordinates).
#
# Notes:
#   Pure bash/awk only (no inline python) to stay shellcheck-clean.
#
set -euo pipefail

usage() {
    printf 'Usage: %s <expected_title> <final_x> <final_y> [screen_w screen_h] [target_cx target_cy] [active_title]\n' "${0##*/}" >&2
    printf '  Gate1: wrong-target FAIL if click<=25px from screen-center while target>150px away\n' >&2
    printf '  Gate2: active title case-insensitive substring-match expected => PASS else FAIL\n' >&2
}

is_number() {
    [[ "${1:-}" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]
}

get_active_title_xprop() {
    local win_id
    local prop_out
    local title
    if ! command -v xprop >/dev/null 2>&1; then
        return 1
    fi
    win_id=""
    win_id=$(xprop -root _NET_ACTIVE_WINDOW 2>/dev/null | awk '{print $NF}' || true)
    case "$win_id" in
        ""|"0x0")
            return 1
            ;;
    esac
    win_id=${win_id%,}
    case "$win_id" in
        ""|"0x0")
            return 1
            ;;
    esac
    prop_out=""
    prop_out=$(xprop -id "$win_id" _NET_WM_NAME WM_NAME 2>/dev/null || true)
    if [ -z "$prop_out" ]; then
        return 1
    fi
    title=""
    title=$(printf '%s\n' "$prop_out" | awk -F'"' '/_NET_WM_NAME/ {print $2; exit}' || true)
    if [ -n "$title" ]; then
        printf '%s' "$title"
        return 0
    fi
    title=$(printf '%s\n' "$prop_out" | awk -F'"' '/WM_NAME/ {print $2; exit}' || true)
    if [ -n "$title" ]; then
        printf '%s' "$title"
        return 0
    fi
    return 1
}

if [ "$#" -lt 3 ]; then
    usage
    printf 'HARD_ERROR expected at least 3 args, got %s\n' "$#" >&2
    exit 2
fi

expected_title=${1:-}
final_x=${2:-}
final_y=${3:-}
screen_w=${4:-}
screen_h=${5:-}
target_cx=${6:-}
target_cy=${7:-}
active_title_input=""
if [ "$#" -ge 8 ]; then
    shift 7
    active_title_input="$*"
fi

if ! [[ "$expected_title" =~ [^[:space:]] ]]; then
    printf 'HARD_ERROR <expected_title> is required (non-blank)\n' >&2
    usage
    exit 2
fi

if ! is_number "$final_x"; then
    printf 'HARD_ERROR <final_x> must be numeric, got %s\n' "$final_x" >&2
    exit 2
fi
if ! is_number "$final_y"; then
    printf 'HARD_ERROR <final_y> must be numeric, got %s\n' "$final_y" >&2
    exit 2
fi
if [ -n "$screen_w" ] && ! is_number "$screen_w"; then
    printf 'HARD_ERROR [screen_w] must be numeric, got %s\n' "$screen_w" >&2
    exit 2
fi
if [ -n "$screen_h" ] && ! is_number "$screen_h"; then
    printf 'HARD_ERROR [screen_h] must be numeric, got %s\n' "$screen_h" >&2
    exit 2
fi
if [ -n "$target_cx" ] && ! is_number "$target_cx"; then
    printf 'HARD_ERROR [target_cx] must be numeric, got %s\n' "$target_cx" >&2
    exit 2
fi
if [ -n "$target_cy" ] && ! is_number "$target_cy"; then
    printf 'HARD_ERROR [target_cy] must be numeric, got %s\n' "$target_cy" >&2
    exit 2
fi

if [ -n "$screen_w" ] && [ -n "$screen_h" ] && [ -n "$target_cx" ] && [ -n "$target_cy" ]; then
    guard_out=""
    guard_out=$(awk -v fx="$final_x" -v fy="$final_y" -v sw="$screen_w" -v sh="$screen_h" -v tx="$target_cx" -v ty="$target_cy" 'BEGIN {
        scx = sw / 2;
        scy = sh / 2;
        dc = sqrt((fx - scx) * (fx - scx) + (fy - scy) * (fy - scy));
        dt = sqrt((tx - scx) * (tx - scx) + (ty - scy) * (ty - scy));
        dct = sqrt((fx - tx) * (fx - tx) + (fy - ty) * (fy - ty));
        trig = (dc <= 25 && (dt > 150 || dct > 150)) ? "TRIGGER" : "OK";
        printf "%s %.2f %.2f %.2f", trig, dc, dt, dct
    }')
    guard_status=""
    d_click=""
    d_target=""
    d_click_target=""
    read -r guard_status d_click d_target d_click_target <<<"$guard_out" || true
    if [ "$guard_status" = "TRIGGER" ]; then
        printf 'FAIL wrong-target click=(%s,%s) within 25px of screen-center (d_click=%spx) while target=(%s,%s) >150px away (d_target=%spx d_click_target=%spx) screen=(%sx%s)\n' \
            "$final_x" "$final_y" "$d_click" "$target_cx" "$target_cy" "$d_target" "$d_click_target" "$screen_w" "$screen_h"
        exit 1
    fi
fi

active_title=""
if [[ "$active_title_input" =~ [^[:space:]] ]]; then
    active_title="$active_title_input"
else
    xprop_title=""
    xprop_title=$(get_active_title_xprop || true)
    if [[ "$xprop_title" =~ [^[:space:]] ]]; then
        active_title="$xprop_title"
    fi
fi

if ! [[ "${active_title:-}" =~ [^[:space:]] ]]; then
    printf 'FAIL no-active-title expected=%s final=(%s,%s) (active_title missing and xprop fallback empty)\n' \
        "$expected_title" "$final_x" "$final_y"
    exit 1
fi

if ACTIVE_TITLE="$active_title" EXPECTED_TITLE="$expected_title" awk 'BEGIN { a = ENVIRON["ACTIVE_TITLE"]; e = ENVIRON["EXPECTED_TITLE"]; exit !(index(tolower(a), tolower(e)) > 0) }'; then
    printf 'PASS focus verified expected=%s active=%s final=(%s,%s)\n' \
        "$expected_title" "$active_title" "$final_x" "$final_y"
    exit 0
else
    printf 'FAIL title-mismatch expected=%s active=%s final=(%s,%s)\n' \
        "$expected_title" "$active_title" "$final_x" "$final_y"
    exit 1
fi
