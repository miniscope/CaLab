"""Summarise eval_evf_floor CSVs (the 2x2 pick-rule sweep).

usage: analyze.py ipm300.csv [fista300.csv ...]
Method labels: F0 = shipped FISTA, I<mode> = interior point with pick rule
  mode 0 frame floor + floor fallback, 1 event-span floor + floor fallback,
  2 event-span floor + min-error fallback, 3 frame floor + min-error fallback.
"""
import sys
import pandas as pd

BANDS = {3: "lo", 5: "lo", 8: "mid", 12: "mid", 20: "hi", 35: "hi", 50: "hi"}


def load(paths):
    df = pd.concat([pd.read_csv(p) for p in paths])
    df = df.drop_duplicates(["ds", "cell", "m"])
    d = df["ds"].str.split("/", expand=True)
    df["regime"], df["preset"], df["fs"] = d[0], d[1], d[2].astype(float).astype(int)
    df["band"] = df["snr"].round().astype(int).map(BANDS)
    df["all"] = "all"
    return df


def agg(g):
    return pd.Series(
        {
            "ratio": g["count"].sum() / max(g["true_count"].sum(), 1),
            "f1": g["f1"].mean(),
            "cap%": 100 * g["cap_limited"].mean(),
            "nofit%": 100 * g["no_size_fit"].mean(),
            "fb": int(g["fb"].sum()),
            "ms": g["ms"].sum() / 1e3,
            "n": len(g),
        }
    )


if __name__ == "__main__":
    df = load(sys.argv[1:])
    methods = [m for m in ["F0", "I0", "I1", "I2", "I3"] if m in set(df["m"])]
    pd.set_option("display.width", 250, "display.max_rows", 500)
    df = df[df["m"].isin(methods)]
    for keys in (
        ["all"],
        ["preset", "fs"],
        ["regime", "preset", "fs"],
        ["preset", "fs", "band"],
        ["regime", "preset", "fs", "band"],
    ):
        t = df.groupby(keys + ["m"]).apply(agg, include_groups=False)
        for col in ("f1", "ratio", "cap%", "nofit%", "ms"):
            print(f"\n== {col} by {keys}")
            print(t[col].unstack("m").round(1 if col in ("cap%", "nofit%", "ms") else 3))
    ipm = df[df["m"].str.startswith("I")]
    print("\nIpm FISTA fallbacks fired:", int(ipm["fb"].sum()), "of", len(ipm), "solves")
