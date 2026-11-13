#!/usr/bin/env bash
# Gets the employee model without Rust: downloads the build CI made on main
# (the Site workflow's employee-model-wasm artifact) into js/wasm/. Needs
# the GitHub CLI, logged in (gh auth login): artifact downloads need a login
# even from a public repository. Every run on main uploads one, kept for 90
# days.
#
# The artifact lists the sources it was built from (sources.txt: the commit,
# then each file the build reads with its blob id, as git ls-tree gives
# them). If one of those files differs here, uncommitted changes included,
# the build isn't this checkout's model: nothing is installed, and
# wasm/build.sh builds it instead.
set -euo pipefail
cd "$(dirname "$0")/.."

name=employee-model-wasm

if ! command -v gh >/dev/null; then
  echo "fetch: needs the GitHub CLI (gh, https://cli.github.com), logged in with gh auth login. Or build the model with wasm/build.sh." >&2
  exit 1
fi
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

# The newest build from a run on main of this repository itself. A pull
# request from a fork runs workflow code its author wrote, and its branch
# can be called main too, so only runs whose head is this repository count.
run=$(gh api "repos/$repo/actions/artifacts?name=$name&per_page=100" --jq '
  [.artifacts[]
   | select((.expired | not)
       and .workflow_run.head_branch == "main"
       and .workflow_run.head_repository_id == .workflow_run.repository_id)]
  | sort_by(.created_at) | last | .workflow_run.id // empty')
if [[ -z $run ]]; then
  echo "fetch: $repo has no $name build from main (they're kept for 90 days). Build the model with wasm/build.sh." >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
gh run download "$run" -R "$repo" -n "$name" -D "$tmp"
for f in employee_model.js employee_model_bg.wasm sources.txt; do
  [[ -f $tmp/$f ]] || { echo "fetch: run $run's $name has no $f." >&2; exit 1; }
done

# Each source as git hashes it here: the working tree's file, so an
# uncommitted change counts.
commit=$(sed -n 's/^# commit //p' "$tmp/sources.txt")
listed=0
differ=()
while IFS=$'\t' read -r entry path; do
  [[ -z $entry || $entry == '#'* ]] && continue
  listed=$((listed + 1))
  if [[ ! -f $path || $(git hash-object -- "$path") != "${entry##* }" ]]; then
    differ+=("$path")
  fi
done < "$tmp/sources.txt"
if (( listed == 0 )); then
  echo "fetch: run $run's $name lists no sources." >&2
  exit 1
fi
if (( ${#differ[@]} )); then
  echo "fetch: the build on GitHub (commit ${commit:0:9}, run https://github.com/$repo/actions/runs/$run) is from other sources than this checkout's:" >&2
  printf '  %s\n' "${differ[@]}" >&2
  echo "Nothing installed. Build the model with wasm/build.sh, or bring wasm/ level with main (git pull) and fetch again." >&2
  exit 1
fi

mkdir -p js/wasm
cp -- "$tmp/employee_model.js" "$tmp/employee_model_bg.wasm" js/wasm/
echo "fetch: js/wasm/ holds the build of commit ${commit:0:9} (https://github.com/$repo/actions/runs/$run), from the same sources as this checkout."
