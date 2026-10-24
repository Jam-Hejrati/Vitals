# The README demo. Record it with docs/demo/record.sh (needs Docker).
#
# It runs the CLI built from this repository (`pnpm build` first), under the command people type,
# so the GIF can be updated before a release. Run with an empty data cache, so the progress is real.
Output docs/demo/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 740
Set Padding 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 70ms
Set WaitTimeout 120s

Hide
Type "cd docs/demo && export PS1='$ ' VITALS_CACHE_DIR=$(mktemp -d)"
Enter
Type "npx() { node /vhs/packages/cli/dist/vitals.js; }"
Enter
Type "clear"
Enter
Sleep 1s
Show

Sleep 600ms
Type "npx dependency-vitals"
Sleep 400ms
Enter
Wait+Screen /healthy/
Sleep 8s
