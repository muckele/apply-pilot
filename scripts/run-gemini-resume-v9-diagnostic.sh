#!/bin/zsh
set -eu
unsetopt XTRACE VERBOSE 2>/dev/null || true
exec node --import tsx scripts/diagnose-gemini-resume-v9.ts
