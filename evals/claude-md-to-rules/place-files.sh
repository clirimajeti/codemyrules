#!/usr/bin/env bash
set -eu
cp -R "$(dirname "$0")/files/." .
# the eval sandbox has no network, so the pinned dependencies are installed here, before the agent starts
(cd shop-web && npm install --include=dev --no-audit --no-fund --loglevel=error)
