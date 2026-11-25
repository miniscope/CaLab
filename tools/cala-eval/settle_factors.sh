#!/bin/sh
# Final settle on Discover's factors against the settle on re-read frames
# (plan: results/2026-11-24-settle-factors-plan.md). One run per call; the caller starts each run.
#
#   settle_factors.sh run  QC_EVAL sim|real RECORDING OUT ARM SEED FRAMES
#       one qc_eval run of ARM (SET-R | SET-F | STR-F) on the first FRAMES frames into OUT/ARM-sSEED
#       (stdout in run.log)
#   settle_factors.sh hold QC_EVAL RECORDING OUT/ARM-sSEED LIB FRAMES
#       the fixed-library run for the held-out proxies: library LIB of that run over the first
#       FRAMES frames (`--library L --dump`), into OUT/ARM-sSEED/hold-LIB
#
# STR-0 (a stream on main: Discover without look-back, no settle) is STR-F's library at the settle's
# start (`footprints_settle0.bin`): the factor dump and the settle-only LookBack leave Discover as it is
# (checked before the runs, plan "Checks").
#
# Paths may contain spaces. Recordings are read-only; every output goes under OUT. Light-job rule:
# at most 2 runs at once.
set -eu

# The app's recording path (look-back + replay + Final settle), as qc_eval models it
# (concsettle2_real.sh and results/2026-11-19-lookback-settle-app.md: COMBO without the drain).
FILE_PATH="--passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6 --lookback-drain 0"
# A stream on main: no look-back, no merge guard; with the replay in the settle only (owner, 23 Nov).
STREAM_PATH="--passes 1 --joint-update refine --joint-sign all --lookback 0"
# The app's settle (SETTLE in apps/cala/src/lib/settle.ts): one pass of at most 18000 frames, in
# 16-frame requests, a checkpoint every 1200 frames. qc_eval's `--settle-frames N` keeps sweeping the
# recording until N frames are fed, so N is capped at the recording's length here.
SETTLE_MAX=18000
SETTLE_REST="--settle-batch 16 --settle-check 1200 --settle-libs"

case $1 in
run)
  BIN=$2 KIND=$3 REC=$4 OUT=$5 ARM=$6 SEED=$7 FRAMES=$8
  DIR=$OUT/$ARM-s$SEED
  SF=$((FRAMES < SETTLE_MAX ? FRAMES : SETTLE_MAX))
  case $ARM in
    SET-R | SET-F) PATHFLAGS=$FILE_PATH ;;
    STR-F) PATHFLAGS=$STREAM_PATH ;;
    *) echo "unknown arm $ARM (SET-R | SET-F | STR-F)" >&2; exit 2 ;;
  esac
  case $KIND in
    sim) KFLAGS="--motion" ;;
    real) KFLAGS="--motion --batch 8 --budget 30000000" ;;
    *) echo "unknown kind $KIND (sim | real)" >&2; exit 2 ;;
  esac
  mkdir -p "$DIR"
  # shellcheck disable=SC2086
  set -- "$KIND" "$REC" "$DIR" $KFLAGS --frames "$FRAMES" --slow-seed "$SEED" $PATHFLAGS \
    --settle-frames "$SF" $SETTLE_REST
  if [ "$ARM" != SET-R ]; then
    set -- "$@" --factors-out "$DIR/factors" --factors-tiling offset --settle-source factors
  fi
  "$BIN" "$@" > "$DIR/run.log" 2>&1
  # The factors are only an input of the settle: drop them to keep the disk.
  rm -rf "$DIR/factors"
  ;;
hold)
  BIN=$2 REC=$3 RUN=$4 LIB=$5 FRAMES=$6
  OUT=$RUN/hold-$LIB
  mkdir -p "$OUT"
  "$BIN" real "$REC" "$OUT" --motion --batch 8 --frames "$FRAMES" --library "$RUN/$LIB.bin" --dump \
    > "$OUT/run.log" 2>&1
  ;;
*)
  sed -n 2,17p "$0"
  exit 2
  ;;
esac
