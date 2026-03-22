#!/usr/bin/env bash
set -euo pipefail

OUT_FILE="${1:-build-meta.json}"

if COMMIT_SHA="$(git rev-parse --short=12 HEAD 2>/dev/null)"; then
  :
else
  COMMIT_SHA="no-commit"
fi

if BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"; then
  :
else
  BRANCH="detached"
fi

if TAG="$(git describe --tags --abbrev=0 2>/dev/null)"; then
  :
else
  TAG="no-tag"
fi

COMMIT_SHA="$(printf '%s' "$COMMIT_SHA" | tr -d '\r\n')"
BRANCH="$(printf '%s' "$BRANCH" | tr -d '\r\n')"
TAG="$(printf '%s' "$TAG" | tr -d '\r\n')"
DIRTY="false"
if ! git diff --quiet 2>/dev/null; then
  DIRTY="true"
fi
BUILD_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "$OUT_FILE" <<JSON
{
  "commitSha": "$COMMIT_SHA",
  "branch": "$BRANCH",
  "tag": "$TAG",
  "dirty": $DIRTY,
  "buildTime": "$BUILD_TIME"
}
JSON

echo "wrote $OUT_FILE"
