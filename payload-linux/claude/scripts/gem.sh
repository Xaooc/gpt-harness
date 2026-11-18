#!/usr/bin/env bash
{ # Whole script is one block: bash parses it all before running, so swapping the file mid-run is safe.
# Gemini executor over Antigravity ACP; flags and output files match luna.sh.
# GEM_SHARED_HOME=1 restores the shared agy home if per-job sign-in fails.
exec node "$(cd "$(dirname "$0")" && pwd)/gem/gem-run.mjs" "$@"

exit $?
}
