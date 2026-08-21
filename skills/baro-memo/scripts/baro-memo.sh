#!/bin/sh
# baro-memo credential store — several boards/tokens on one machine.
#
#   ~/.config/baro-memo/
#   ├── env                  legacy single profile (still honoured, never deleted)
#   ├── default              one line: the profile name to use when none is named
#   └── profiles/<name>.env  BARO_MEMO_URL + BARO_MEMO_TOKEN, mode 600
#
# The token never travels through argv (shell history, ps) and is never printed.
# `add` reads it from stdin; everything else hands you a *path* to source:
#
#   . "$(baro-memo.sh path)"            # default profile
#   . "$(baro-memo.sh path lab)"        # a named one
#
# Commands:
#   list                 profiles, their URLs, which is default (no tokens)
#   path [name]          absolute path of a profile file, for sourcing
#   add <name> <url>     create/replace a profile; token on stdin
#   use <name>           set the default profile
#   check [name]         board liveness + whether the token is accepted
#   migrate [name]       copy the legacy env into profiles/<name>.env (default: main)
#
set -eu

CONFIG_DIR="${BARO_MEMO_CONFIG_DIR:-${HOME}/.config/baro-memo}"
PROFILE_DIR="${CONFIG_DIR}/profiles"
LEGACY="${CONFIG_DIR}/env"
DEFAULT_FILE="${CONFIG_DIR}/default"

die() { echo "$@" >&2; exit 1; }

profile_file() { echo "${PROFILE_DIR}/$1.env"; }

profile_names() {
    [ -d "$PROFILE_DIR" ] || return 0
    for f in "$PROFILE_DIR"/*.env; do
        [ -e "$f" ] || continue
        basename "$f" .env
    done
}

count_profiles() { profile_names | wc -l | tr -d ' '; }

# URL of a profile file, for display. Tokens are never read out.
url_of() { sed -n 's/^BARO_MEMO_URL=//p' "$1" | head -1; }

# Resolution order: explicit name -> `default` file -> the only profile -> legacy env.
resolve() {
    if [ $# -ge 1 ] && [ -n "${1:-}" ]; then
        f=$(profile_file "$1")
        [ -f "$f" ] || die "no such profile: $1  (baro-memo.sh list)"
        echo "$f"
        return
    fi
    if [ -f "$DEFAULT_FILE" ]; then
        name=$(head -1 "$DEFAULT_FILE" | tr -d '\r\n')
        f=$(profile_file "$name")
        [ -f "$f" ] || die "default profile '$name' is missing  (baro-memo.sh use <name>)"
        echo "$f"
        return
    fi
    if [ "$(count_profiles)" = "1" ]; then
        profile_file "$(profile_names)"
        return
    fi
    if [ -f "$LEGACY" ]; then
        echo "$LEGACY"
        return
    fi
    if [ "$(count_profiles)" -gt 1 ]; then
        die "several profiles and no default  (baro-memo.sh use <name>)"
    fi
    die "no profile configured  (baro-memo.sh add <name> <url>)"
}

cmd_list() {
    found=0
    if [ -f "$DEFAULT_FILE" ]; then
        default_name=$(head -1 "$DEFAULT_FILE" | tr -d '\r\n')
    else
        default_name=""
    fi
    for name in $(profile_names); do
        found=1
        f=$(profile_file "$name")
        mark="  "
        [ "$name" = "$default_name" ] && mark="* "
        printf '%s%-16s %s\n' "$mark" "$name" "$(url_of "$f")"
    done
    if [ -f "$LEGACY" ]; then
        found=1
        mark="  "
        [ -z "$default_name" ] && [ "$(count_profiles)" = "0" ] && mark="* "
        printf '%s%-16s %s   (legacy ~/.config/baro-memo/env)\n' "$mark" "-" "$(url_of "$LEGACY")"
    fi
    [ "$found" = "1" ] || echo "no profiles configured"
}

cmd_add() {
    [ $# -ge 2 ] || die "usage: baro-memo.sh add <name> <url>   (token on stdin)"
    name=$1
    url=$(echo "$2" | sed 's#/*$##')
    case "$name" in
        */*|.|..|"") die "bad profile name: $name" ;;
    esac
    token=$(cat)
    token=$(echo "$token" | tr -d '\r\n')
    [ -n "$token" ] || die "empty token on stdin"

    mkdir -p "$PROFILE_DIR"
    chmod 700 "$PROFILE_DIR"
    f=$(profile_file "$name")
    : > "$f"
    chmod 600 "$f"
    printf 'BARO_MEMO_URL=%s\nBARO_MEMO_TOKEN=%s\n' "$url" "$token" > "$f"
    echo "wrote $f (mode 600)"

    [ -f "$DEFAULT_FILE" ] || cmd_use "$name"
}

cmd_use() {
    [ $# -ge 1 ] || die "usage: baro-memo.sh use <name>"
    f=$(profile_file "$1")
    [ -f "$f" ] || die "no such profile: $1"
    mkdir -p "$CONFIG_DIR"
    echo "$1" > "$DEFAULT_FILE"
    echo "default profile: $1"
}

cmd_check() {
    f=$(resolve "${1:-}")
    # shellcheck disable=SC1090
    . "$f"
    [ -n "${BARO_MEMO_URL:-}" ] || die "$f has no BARO_MEMO_URL"
    echo "profile : $f"
    echo "board   : $BARO_MEMO_URL"

    health=$(curl -s --max-time 5 "$BARO_MEMO_URL/health" || true)
    case "$health" in
        *'"ok":true'*) echo "health  : ok" ;;
        "")            die "health  : no answer — wrong address, or the board is down" ;;
        *)             die "health  : unexpected answer: $health" ;;
    esac

    [ -n "${BARO_MEMO_TOKEN:-}" ] || die "token   : not set in $f"
    # An empty body is rejected *after* auth, so the refusal code tells the two apart.
    # Nothing is written to the board either way.
    probe=$(printf '{}' | curl -s --max-time 5 -X POST "$BARO_MEMO_URL/memos" \
        -H "x-memo-token: $BARO_MEMO_TOKEN" -H 'content-type: application/json' \
        --data-binary @- || true)
    case "$probe" in
        *empty_body*)          echo "token   : accepted" ;;
        *memo_token_invalid*)  die "token   : rejected — ask the operator for a valid one (/memo/admin/)" ;;
        *no_tokens_issued*)    die "token   : the board has issued none; no value will work" ;;
        *)                     die "token   : unexpected answer: $probe" ;;
    esac
}

cmd_migrate() {
    name=${1:-main}
    [ -f "$LEGACY" ] || die "nothing to migrate: $LEGACY does not exist"
    mkdir -p "$PROFILE_DIR"
    chmod 700 "$PROFILE_DIR"
    f=$(profile_file "$name")
    [ -f "$f" ] && die "profile already exists: $f"
    : > "$f"
    chmod 600 "$f"
    cat "$LEGACY" > "$f"
    echo "copied $LEGACY -> $f (the original is left in place)"
    [ -f "$DEFAULT_FILE" ] || cmd_use "$name"
}

case "${1:-}" in
    list)    shift; cmd_list "$@" ;;
    path)    shift; resolve "${1:-}" ;;
    add)     shift; cmd_add "$@" ;;
    use)     shift; cmd_use "$@" ;;
    check)   shift; cmd_check "${1:-}" ;;
    migrate) shift; cmd_migrate "${1:-}" ;;
    ""|-h|--help)
        sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
        ;;
    *) die "unknown command: $1  (baro-memo.sh --help)" ;;
esac
