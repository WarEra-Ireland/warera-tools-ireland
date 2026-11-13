#!/usr/bin/env bash
# Builds the employee model crate into js/wasm/ (--target no-modules), which
# the page and its workers load, and Node through wasm/node.cjs.
# The toolchain comes from rust-toolchain.toml; wasm-bindgen-cli must be the
# version Cargo.lock pins, and wasm-opt (binaryen) the version below: CI
# builds the deployed .wasm with the same pins, and another version gives
# other bytes. js/wasm/ isn't in git; the deploy stamps its cache tag.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"

want=$(awk '$0 == "name = \"wasm-bindgen\"" { getline; gsub(/[^0-9.]/, "", $3); print $3 }' Cargo.lock)
have=$(wasm-bindgen --version 2>/dev/null | awk '{ print $2 }') || true
if [ -z "$want" ] || [ "$have" != "$want" ]; then
  echo "wasm-bindgen-cli is '${have:-missing}', Cargo.lock pins '$want'." >&2
  echo "Install it with: cargo install --locked wasm-bindgen-cli --version $want" >&2
  exit 1
fi

wasm_opt_want=133
wasm_opt_have=$(wasm-opt --version 2>/dev/null | awk '{ print $3 }') || true
if [ "$wasm_opt_have" != "$wasm_opt_want" ]; then
  echo "wasm-opt is '${wasm_opt_have:-missing}', build.sh pins $wasm_opt_want." >&2
  echo "Install binaryen version_$wasm_opt_want from https://github.com/WebAssembly/binaryen/releases" >&2
  exit 1
fi

cargo fmt --check >/dev/null || { echo "Not formatted: run cargo fmt in wasm/ first." >&2; exit 1; }
# Path-free builds, so the .wasm is the same bytes whichever checkout and
# home build it: crates.io sources would otherwise carry absolute paths
# into panic locations. The crate's own paths are already relative. The
# sources are unpacked first: the remap lists what is unpacked, and a fresh
# Cargo home (a CI runner, rust-cache) has nothing there until the build.
cargo fetch --locked --quiet
remap=()
for d in "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/; do remap+=("--remap-path-prefix=$d="); done
RUSTFLAGS="${remap[*]}" cargo build --release --locked --target wasm32-unknown-unknown
wasm=${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/employee_model.wasm
wasm-bindgen --target no-modules --no-typescript --remove-name-section --remove-producers-section --out-dir ../js/wasm "$wasm"

# The features rustc enables by default for wasm32-unknown-unknown.
f=../js/wasm/employee_model_bg.wasm
wasm-opt -O3 --enable-bulk-memory --enable-mutable-globals --enable-nontrapping-float-to-int \
  --enable-sign-ext --enable-reference-types --enable-multivalue "$f" -o "$f"

for f in ../js/wasm/employee_model.js ../js/wasm/employee_model_bg.wasm; do
  printf '%-36s %7d B, %6d B gzip\n' "${f#../}" "$(wc -c < "$f")" "$(gzip -9n < "$f" | wc -c)"
done
