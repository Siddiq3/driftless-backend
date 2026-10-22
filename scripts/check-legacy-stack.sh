#!/usr/bin/env bash
set -euo pipefail
error_file=$(mktemp)
trap 'rm -f "$error_file"' EXIT
if aws cloudformation describe-stacks --stack-name Driftless-prod --query 'Stacks[0].StackId' --output text 2>"$error_file"; then
  echo 'Existing Driftless-prod CDK stack detected. Deployment stopped to protect its data. See docs/DEPLOYMENT.md for migration requirements.' >&2
  exit 1
fi
if ! grep -Eq 'ValidationError.*Stack with id Driftless-prod does not exist' "$error_file"; then
  cat "$error_file" >&2
  exit 1
fi
echo 'No legacy CDK production stack exists; Serverless deployment can proceed.'
