#!/bin/sh
# Usage: sh run_matrix.sh > matrix_raw.txt
# Build first: cargo test --release --lib fast_relaxed_eval --no-run
export PATH=$HOME/.cargo/bin:$PATH
cd "$(dirname "$0")/.."
BIN=${BIN:-$(ls -t target/release/deps/calab_solver-* | grep -v "\.d$" | head -1)}
run() { # preset fs dur snr mfr cells tight
  FR_PRESET=$1 FR_FS=$2 FR_DUR=$3 FR_SNR=$4 FR_MFR=$5 FR_CELLS=$6 FR_TIGHT=$7 \
    $BIN fast_relaxed_eval --ignored --nocapture --test-threads 1 2>&1 | grep -E "SUMMARY" | sed "s/^.*SUMMARY/tight=$7 SUMMARY/"
}
for p in jgcamp8f gcamp6s; do
  for fs in 30 60; do
    for d in 600 1800; do
      for snr in 5 12; do run $p $fs $d $snr 300 3 0; done
    done
  done
  run $p 30 600 8 100 3 0
done
for p in jgcamp8f gcamp6s; do run $p 30 600 8 300 3 1; run $p 60 300 8 300 2 1; done
