#!/usr/bin/env bash
# Fails if the repo holds a secret, a personal identity or a production name.
#
#   scripts/scan-public.sh              working tree (tracked and untracked) and
#                                       the current branch's commit messages
#   scripts/scan-public.sh --all-refs   every commit reachable from any ref
#
# To cover pull request refs first:
#   git fetch origin '+refs/pull/*/head:refs/remotes/pr/*'
#
# Names that must stay out of this file, such as clients, go in SCAN_EXTRA_PATTERNS
# as an extended regex. It is matched case-insensitively.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

# Fragments are split so this file does not match itself.
OWNER_DOMAIN='uplifted''consulting'
OWNER_NAME='Ricc''ardo'
PERSONAL_EMAIL='[A-Za-z0-9._%+-]+@(gmail|icloud|me|outlook|hotmail|proton|protonmail|yahoo)\.[a-z]+'

# One "name|regex" per line. The name holds no "|".
PATTERNS="owner domain|$OWNER_DOMAIN
owner name|$OWNER_NAME
personal email|$PERSONAL_EMAIL
production host|docs\.uplifted
production bucket|docs-cloud-images
production database|(database_name|database_id|d1 create).{0,12}docs-cloud
production worker|\"name\": *\"docs-cloud\"
database id|database_id\"?[ :=]+\"?[0-9a-f-]{32,}
cloudflare value|CLOUDFLARE_[A-Z_]+ *[=:] *[\"']?[A-Za-z0-9_-]{16,}
local path|/Users/[a-z]
resend key|(^|[^A-Za-z0-9_])re_[A-Za-z0-9_]{16,}
docs token|(^|[^A-Za-z0-9_])dct_[A-Za-z0-9_-]{16,}
api key|(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}
github token|(^|[^A-Za-z0-9_])(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})
aws key|(^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}
private key|-----BEGIN [A-Z ]*PRIVATE KEY"

status=0
found() { # label, hits
  echo "FOUND [$1]"
  sed 's/^/  /' <<<"$2" | cut -c1-160
  status=1
}

# Scans one tree: the working tree when the argument is empty, else that commit.
scan_tree() {
  local commit=$1 name regex hits flags
  while IFS='|' read -r name regex; do
    flags=-nIE
    [[ $name == "private names" ]] && flags=-niIE
    # The copyright line in LICENSE is the one allowed use of the owner's name.
    if [[ -n $commit ]]; then
      hits=$(git --no-pager grep "$flags" -e "$regex" "$commit" -- . \
        ':(exclude)scripts/scan-public.sh' ':(exclude)LICENSE')
      if [[ $name != "owner name" ]]; then
        hits+=$(git --no-pager grep "$flags" -e "$regex" "$commit" -- LICENSE)
      fi
    else
      hits=$(git --no-pager grep --untracked "$flags" -e "$regex" -- . \
        ':(exclude)scripts/scan-public.sh' ':(exclude)LICENSE')
      if [[ $name != "owner name" ]]; then
        hits+=$(git --no-pager grep --no-index "$flags" -e "$regex" -- LICENSE)
      fi
    fi
    [[ -n $hits ]] && found "$name" "$hits"
  done <<<"$RULES"
}

scan_text() { # label prefix, text
  local name regex hits flags
  while IFS='|' read -r name regex; do
    flags=-nE
    [[ $name == "private names" ]] && flags=-niE
    hits=$(grep "$flags" -e "$regex" <<<"$2")
    [[ -n $hits ]] && found "$name in $1" "$hits"
  done <<<"$RULES"
}

RULES=$PATTERNS
if [[ -n ${SCAN_EXTRA_PATTERNS:-} ]]; then
  RULES+=$'\n'"private names|$SCAN_EXTRA_PATTERNS"
fi

if [[ ${1:-} == --all-refs ]]; then
  range=(--all)
  commits=$(git rev-list --all)
  echo "Scanning $(wc -l <<<"$commits" | tr -d ' ') commits on all refs"
  for commit in $commits; do scan_tree "$commit"; done
else
  range=(HEAD)
  echo "Scanning the working tree"
  scan_tree ""
fi

scan_text "commit messages" "$(git log "${range[@]}" --format='%H %s%n%b')"

# Author and committer names are expected to be the owner's; addresses are not.
RULES="owner domain|$OWNER_DOMAIN
personal email|$PERSONAL_EMAIL"
scan_text "commit authors" "$(git log "${range[@]}" --format='%h %ae %ce')"

if ((status == 0)); then echo "Clean"; fi
exit "$status"
