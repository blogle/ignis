#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -C "$root" --null -T <(while IFS= read -r -d '' file; do test -e "$root/$file" && printf '%s\0' "$file"; done < <(git -C "$root" ls-files --cached --others --exclude-standard -z)) -cf - | tar -C "$tmp" -xf -
for sibling in chadlands telegram_collector chatgpt_collector dotfiles; do test ! -e "$tmp/../$sibling"; done
npm --prefix "$tmp" ci --ignore-scripts
npm --prefix "$tmp" run lint
npm --prefix "$tmp" test
