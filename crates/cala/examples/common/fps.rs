//! The frame rate of a Miniscope recording directory, by the app's rule
//! (`apps/cala/src/lib/frame-source.ts`): measured beats nominal, so the
//! timestamps first (`timeStamps.csv`), then `metaData.json`'s
//! `frameRate`. The AVI header's own rate is never used.

use std::path::Path;

/// The recording's frame rate, Hz, and where it came from; `None` when
/// neither file gives one.
pub fn recording_fps(dir: &Path) -> Option<(f64, &'static str)> {
    if let Some(f) = std::fs::read_to_string(dir.join("timeStamps.csv"))
        .ok()
        .and_then(|t| fps_from_timestamps(&t))
    {
        return Some((f, "timeStamps.csv"));
    }
    std::fs::read_to_string(dir.join("metaData.json"))
        .ok()
        .and_then(|t| fps_from_metadata(&t))
        .map(|f| (f, "metaData.json"))
}

/// The rate of `timeStamps.csv` (header `Frame Number,Time Stamp (ms),...`):
/// 1000 over the mean frame interval, ms, of the positive intervals up to
/// twice their median (dropped frames left out). `None` for fewer than two
/// timestamps or no time column.
pub fn fps_from_timestamps(text: &str) -> Option<f64> {
    let mut lines = text.lines();
    let header: Vec<String> = lines
        .next()?
        .split(',')
        .map(|h| h.trim().to_lowercase())
        .collect();
    let col = header
        .iter()
        .position(|h| h.starts_with("time stamp") || h == "timestamp")?;
    let ms: Vec<f64> = lines
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| l.split(',').nth(col)?.trim().parse().ok())
        .filter(|v: &f64| v.is_finite())
        .collect();
    let diffs: Vec<f64> = ms
        .windows(2)
        .map(|w| w[1] - w[0])
        .filter(|&d| d > 0.0)
        .collect();
    if diffs.is_empty() {
        return None;
    }
    let mut sorted = diffs.clone();
    sorted.sort_by(f64::total_cmp);
    let n = sorted.len();
    let med = if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    };
    let kept: Vec<f64> = diffs.into_iter().filter(|&d| d <= 2.0 * med).collect();
    let mean = kept.iter().sum::<f64>() / kept.len() as f64;
    Some(1000.0 / mean)
}

/// `metaData.json`'s `frameRate` (`"20FPS"`, `"30 fps"`, `"15.5"` or a
/// number), when positive.
pub fn fps_from_metadata(text: &str) -> Option<f64> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let f = match &v["frameRate"] {
        serde_json::Value::Number(n) => n.as_f64()?,
        serde_json::Value::String(s) => {
            let t = s.trim().to_lowercase();
            let t = t.strip_suffix("fps").or(t.strip_suffix("hz")).unwrap_or(&t);
            t.trim().parse().ok()?
        }
        _ => return None,
    };
    (f.is_finite() && f > 0.0).then_some(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_give_the_mean_interval_without_drops() {
        let t =
            "Frame Number,Time Stamp (ms),Buffer Index\n0,0,0\n1,50,0\n2,100,0\n3,250,0\n4,300,0\n";
        // 50, 50, 150 (a drop, left out), 50.
        assert_eq!(fps_from_timestamps(t), Some(20.0));
        assert_eq!(
            fps_from_timestamps("Frame Number,Time Stamp (ms)\n0,0\n"),
            None
        );
        assert_eq!(fps_from_timestamps("a,b\n0,0\n1,50\n"), None);
    }

    #[test]
    fn metadata_rates_parse() {
        assert_eq!(fps_from_metadata(r#"{"frameRate": "20FPS"}"#), Some(20.0));
        assert_eq!(fps_from_metadata(r#"{"frameRate": "30 fps"}"#), Some(30.0));
        assert_eq!(fps_from_metadata(r#"{"frameRate": 15.5}"#), Some(15.5));
        assert_eq!(fps_from_metadata(r#"{"frameRate": "0"}"#), None);
        assert_eq!(fps_from_metadata(r#"{"ROI": {}}"#), None);
    }
}
