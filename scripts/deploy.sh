#!/bin/sh
# Applies D1 migrations, then deploys, so live code never runs on an older
# schema. Without a database_id, the first `wrangler deploy` is what creates the
# database, so it has to run before there is anything to migrate. Any failure
# other than a missing database stops here, before new code goes live.
set -eu

if ! output=$(wrangler d1 migrations list DB --remote 2>&1); then
  printf '%s\n' "$output" >&2
  case "$output" in
    *"Couldn't find a D1 DB"*) wrangler deploy ;;
    *) exit 1 ;;
  esac
fi

wrangler d1 migrations apply DB --remote
wrangler deploy
