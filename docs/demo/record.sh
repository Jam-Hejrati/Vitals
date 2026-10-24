#!/usr/bin/env bash
# Records docs/demo/demo.gif from demo.tape, in Docker so the result is the same everywhere.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker image inspect vitals-vhs >/dev/null 2>&1 || docker build -q -t vitals-vhs docs/demo >/dev/null
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/vhs" vitals-vhs docs/demo/demo.tape
