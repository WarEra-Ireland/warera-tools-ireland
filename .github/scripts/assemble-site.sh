#!/usr/bin/env bash
# Assembles the site into _site/ at the checkout's root: the tracked files
# that ship, at the paths they have here, plus the built employee model in
# js/wasm/ (run wasm/build.sh first). Then stamp-tags.cjs sets the ?v= and
# worker ?w= cache tags in _site/ from the files' contents; the source keeps
# its own. To try it locally, run `python3 -m http.server` from inside _site/.
#
# Left out:
#   .github/              CI config and these scripts
#   wasm/                 the model's Rust sources: its build ships in js/wasm/
#   worker/               the Cloudflare Worker, deployed with wrangler
#   *.py                  the data bots' scripts, run in Actions
#   README.md             the repo's docs
#   CNAME                 a deployment from Actions ignores it: the custom
#                         domain is a repository setting
#   .gitignore .nojekyll  git's and the branch build's files
# Untracked files never ship (wasm/target/, _site/ itself).
set -euo pipefail

if (( $# )); then
  echo "assemble-site: takes no arguments; it always writes _site/ at the checkout's root." >&2
  exit 2
fi
cd "$(git rev-parse --show-toplevel)"
if [[ -n $(git ls-files -- _site) ]]; then
  echo "assemble-site: _site/ holds tracked files; it must be this script's output only." >&2
  exit 1
fi

model=(js/wasm/employee_model.js js/wasm/employee_model_bg.wasm)
for f in "${model[@]}"; do
  [[ -f $f ]] || { echo "assemble-site: no $f: run wasm/build.sh first." >&2; exit 1; }
done

# The one thing this deletes: its own previous output, at a fixed path.
rm -rf -- _site
mkdir -- _site
git ls-files -z -- . ':!.github/' ':!wasm/' ':!worker/' ':!*.py' ':!README.md' ':!CNAME' ':!.gitignore' ':!.nojekyll' ':!js/wasm/' |
  tar -cf - --null -T - | tar -xf - -C _site
mkdir -p -- _site/js/wasm
cp -- "${model[@]}" _site/js/wasm/
node .github/scripts/stamp-tags.cjs _site

echo "assemble-site: $(find _site -type f | wc -l) files, $(du -sh --apparent-size -- _site | cut -f1), in $PWD/_site"
