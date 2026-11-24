#!/usr/bin/env bash
{ # Whole script is one block: bash parses it all before running, so swapping the file mid-run is safe.
# ML AI Code executor; flags and output files match luna.sh.
exec node "$(cd "$(dirname "$0")" && pwd)/mlai/mlai-run.mjs" "$@"
exit $?
}
