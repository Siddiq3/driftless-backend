#!/usr/bin/env bash
# usage: ci/step.sh <name> <command...>
# Runs a command, tees output to ci-logs/<job>/<name>.log, records the exit status.
set -uo pipefail
name="$1"; shift
dir="${GITHUB_WORKSPACE:-.}/ci-logs/${CI_JOB:-local}"
mkdir -p "$dir"
start=$(date +%s)
"$@" 2>&1 | tee "$dir/$name.log"
code=${PIPESTATUS[0]}
echo "$name exit=$code secs=$(( $(date +%s) - start ))" >> "$dir/status.txt"
exit "$code"
