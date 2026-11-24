//! Pure update bookkeeping: the staged/downloaded version decisions and the
//! arithmetic behind the download indicator.
//!
//! Nothing here touches Tauri, the filesystem, or the network, so it is
//! exercised directly.

/// Version the operator declined, stored so the same update asks once.
pub const DECLINED_FILE: &str = "update-declined";
/// Target of the last update attempt, acknowledged only by that running version.
pub const APPLIED_FILE: &str = "update-applied";
/// Version whose installer a previous launch staged.
pub const STAGED_FILE: &str = "update-staged";
/// Staged installer bytes, alongside `STAGED_FILE`.
pub const STAGED_PAYLOAD: &str = "update-staged.bin";

/// Compute the completed fraction of one download step.
/// @param downloaded - bytes received so far.
/// @param total - the announced length, when known.
/// @returns the fraction, or `None` when the length is unusable.
pub fn ratio_of(downloaded: usize, total: Option<u64>) -> Option<f64> {
    let total = total.filter(|total| *total > 0)?;
    Some(clamp_ratio(downloaded as f64 / total as f64))
}

/// The whole percent a ratio shows, used to skip redundant updates.
/// @param ratio - completed fraction.
/// @returns the percentage rounded to the nearest whole number.
pub fn percent_of(ratio: f64) -> i64 {
    (clamp_ratio(ratio) * 100.0).round() as i64
}

/// Keep a ratio inside the bar's range.
fn clamp_ratio(ratio: f64) -> f64 {
    if ratio.is_nan() {
        return 0.0;
    }
    ratio.clamp(0.0, 1.0)
}

/// Whether this version may be offered, given the one the operator declined.
/// @param declined - the version recorded from a previous refusal.
/// @param version - the version the feed announces now.
/// @returns true when the window should open.
pub fn should_offer(declined: Option<&str>, version: &str) -> bool {
    declined != Some(version)
}

/// Whether a launch should apply an installer another launch staged.
/// @param staged - version recorded beside the staged installer.
/// @param running - version embedded in the running application.
/// @returns true only when the staged version is not the running one.
pub fn should_acknowledge_newer(staged: &str, running: &str) -> bool {
    !staged.is_empty() && staged != running
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_offers_a_version_that_was_not_declined() {
        assert!(should_offer(None, "1.0.0"));
        assert!(should_offer(Some("0.9.0"), "1.0.0"));
        assert!(!should_offer(Some("1.0.0"), "1.0.0"));
    }

    #[test]
    fn applies_only_a_staged_version_the_launch_is_not_running() {
        assert!(should_acknowledge_newer("1.0.1", "1.0.0"));
        assert!(!should_acknowledge_newer("1.0.0", "1.0.0"));
        assert!(!should_acknowledge_newer("", "1.0.0"));
    }

    #[test]
    fn reports_whole_percentages_within_the_bar() {
        assert_eq!(percent_of(0.0), 0);
        assert_eq!(percent_of(0.505), 51);
        assert_eq!(percent_of(1.4), 100);
        assert_eq!(ratio_of(50, Some(100)), Some(0.5));
        assert_eq!(ratio_of(50, Some(0)), None);
        assert_eq!(ratio_of(50, None), None);
    }
}
