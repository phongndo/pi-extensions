#!/usr/bin/env bash
# Apply patches/pi-claude-cli.patch to pi's checkout of pi-claude-cli.
#
#   patches/apply-pi-claude-cli.sh [CHECKOUT]
#
# CHECKOUT defaults to pi's managed checkout of the git source
# (~/.pi/agent/git/github.com/dmmulroy/pi-claude-cli, or under
# $PI_CODING_AGENT_DIR). The patch is made against UPSTREAM_REV below; pin the
# source to it so `pi update` keeps that revision:
#
#   pi install git:github.com/dmmulroy/pi-claude-cli@<UPSTREAM_REV>
#
# Safe to run again: an applied patch is left alone, and nothing is reset or
# cleaned. `pi update` may restore the checkout, so run this after it, then
# /reload pi.
set -euo pipefail

UPSTREAM_REV=802744c4426e9f4e7372e9fb9d962ba1654565fe
PATCH="$(cd "$(dirname "$0")" && pwd)/pi-claude-cli.patch"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
CHECKOUT="${1:-$AGENT_DIR/git/github.com/dmmulroy/pi-claude-cli}"

if ! git -C "$CHECKOUT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "No git checkout of pi-claude-cli at $CHECKOUT." >&2
  echo "Install it first: pi install git:github.com/dmmulroy/pi-claude-cli@$UPSTREAM_REV" >&2
  exit 1
fi

if git -C "$CHECKOUT" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  echo "Already patched: $CHECKOUT"
  exit 0
fi

head="$(git -C "$CHECKOUT" rev-parse HEAD)"
if [ "$head" != "$UPSTREAM_REV" ]; then
  echo "warning: $CHECKOUT is at $head, the patch was made against $UPSTREAM_REV." >&2
fi

if ! git -C "$CHECKOUT" apply --check "$PATCH" 2>/dev/null; then
  echo "The patch does not apply to $CHECKOUT; nothing was changed." >&2
  echo "Check out $UPSTREAM_REV there (pin the pi source to it), or regenerate the patch." >&2
  git -C "$CHECKOUT" apply --check "$PATCH" || true
  exit 1
fi

git -C "$CHECKOUT" apply "$PATCH"
echo "Patched $CHECKOUT. Run /reload in pi."
