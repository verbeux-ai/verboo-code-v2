//! Pure update-window logic: the scripts the window evaluates and the arithmetic
//! behind its progress bar.
//!
//! Nothing here touches Tauri, the filesystem, or the network, so it is exercised
//! directly. Every value a script embeds is serialized as JSON, which is also
//! valid JavaScript source: a translated string or a version containing quotes
//! cannot break out of the assignment.

/// Version the operator declined, stored so the same update asks once.
pub const DECLINED_FILE: &str = "update-declined";
/// Target of the last update attempt, acknowledged only by that running version.
pub const APPLIED_FILE: &str = "update-applied";
/// The window offering and reporting the update.
pub const UPDATE_WINDOW: &str = "update";
/// The window confirming that the update was applied.
pub const UPDATED_WINDOW: &str = "updated";
/// Copy for the update window, in both its offer and running states.
pub struct OfferCopy<'a> {
    /// Version the feed announced.
    pub version: &'a str,
    /// Heading while the update is offered.
    pub title: &'a str,
    /// Explanation while the update is offered.
    pub body: &'a str,
    /// Confirm button.
    pub install: &'a str,
    /// Decline button.
    pub later: &'a str,
    /// Dismiss button after a failed install.
    pub close: &'a str,
    /// Message shown when the install fails.
    pub failed: &'a str,
    /// Label for the safe diagnostic code shown after a failed install.
    pub diagnostic_label: &'a str,
}

/// Copy shown once the download is running.
pub struct RunningCopy<'a> {
    /// Heading while the download runs.
    pub title: &'a str,
    /// Explanation while the download runs.
    pub body: &'a str,
    /// Status line above the percentage, and the bar's accessible name.
    pub status: &'a str,
}

/// Serialize one value as a JavaScript assignment into `window`.
fn assignment(name: &str, payload: serde_json::Value) -> String {
    format!("window.{name} = {payload};")
}

/// Hand the offer window its copy before the document loads.
/// @param copy - the offer text and the version it names.
/// @returns a script statement assigning `window.__VERBOO_UPDATE__`.
pub fn copy_script(copy: &OfferCopy<'_>) -> String {
    assignment(
        "__VERBOO_UPDATE__",
        serde_json::json!({
            // The feed's version may carry its own "v"; the window shows one.
            "version": copy.version.trim_start_matches(['v', 'V']),
            "title": copy.title,
            "body": copy.body,
            "install": copy.install,
            "later": copy.later,
            "close": copy.close,
            "failed": copy.failed,
            "diagnosticLabel": copy.diagnostic_label,
        }),
    )
}

/// Hand the notice window its copy before the document loads.
/// @param title - heading of the notice.
/// @param body - detail line naming the running version.
/// @param ok_label - localized action label that closes the notice.
/// @returns a script statement assigning `window.__VERBOO_UPDATED__`.
pub fn applied_script(title: &str, body: &str, ok_label: &str) -> String {
    assignment(
        "__VERBOO_UPDATED__",
        serde_json::json!({ "title": title, "body": body, "okLabel": ok_label }),
    )
}

/// Switch the offer window to its running state.
/// @param copy - the running-state text.
/// @returns the statement that swaps the offer for the progress bar.
pub fn running_script(copy: &RunningCopy<'_>) -> String {
    format!(
        "window.__enterProgress({});",
        serde_json::json!({
            "title": copy.title,
            "body": copy.body,
            "status": copy.status,
        }),
    )
}

/// Switch from download progress to an indeterminate finalization state.
/// @param status - localized text shown while verification and installation run.
/// @returns the statement that clears the percentage and shows motion.
pub fn finalizing_script(status: &str) -> String {
    format!(
        "window.__enterFinalizing({});",
        serde_json::json!({ "status": status })
    )
}

/// Move the bar to `ratio` of the download.
/// @param ratio - completed fraction, clamped to 0..=1.
/// @returns the statement that sets the width and the percentage.
pub fn progress_script(ratio: f64) -> String {
    format!("window.__setProgress({});", clamp_ratio(ratio))
}

/// Report an install failure in place.
/// @param message - what the window should say.
/// @returns the statement that replaces the bar with the failure.
pub fn fail_script(message: &str, diagnostic_code: &str) -> String {
    format!(
        "window.__fail({});",
        serde_json::json!({ "message": message, "code": diagnostic_code }),
    )
}

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

/// Whether the update target was reached by the running application.
/// @param target - version recorded before invoking the installer.
/// @param running - version embedded in the running application.
/// @returns true only for a nonempty target equal to the running version.
pub fn should_acknowledge(target: &str, running: &str) -> bool {
    !target.is_empty() && target == running
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer(version: &str) -> OfferCopy<'_> {
        OfferCopy {
            version,
            title: "Update available",
            body: "Ready to install.",
            install: "Download and restart",
            later: "Not now",
            close: "Close",
            failed: "The update could not be completed.",
            diagnostic_label: "Diagnostic code",
        }
    }

    fn running() -> RunningCopy<'static> {
        RunningCopy {
            title: "Updating Verboo Code",
            body: "This takes a moment.",
            status: "Downloading",
        }
    }

    #[test]
    fn script_names_are_the_ones_the_pages_read() {
        assert!(copy_script(&offer("1.0.0")).starts_with("window.__VERBOO_UPDATE__ = "));
        assert!(applied_script("a", "b", "OK").starts_with("window.__VERBOO_UPDATED__ = "));
        assert_eq!(running_script(&running()), "window.__enterProgress({\"body\":\"This takes a moment.\",\"status\":\"Downloading\",\"title\":\"Updating Verboo Code\"});");
        assert_eq!(
            finalizing_script("Finalizing installation"),
            "window.__enterFinalizing({\"status\":\"Finalizing installation\"});"
        );
        assert_eq!(progress_script(0.5), "window.__setProgress(0.5);");
        assert_eq!(
            fail_script("boom", "invalid-installer-format"),
            "window.__fail({\"code\":\"invalid-installer-format\",\"message\":\"boom\"});"
        );
    }

    #[test]
    fn a_mark_prefixed_version_is_shown_once() {
        for version in ["v0.2.2-alpha.12", "V0.2.2-alpha.12", "0.2.2-alpha.12"] {
            let script = copy_script(&offer(version));
            assert!(
                script.contains("\"version\":\"0.2.2-alpha.12\""),
                "{version} -> {script}"
            );
        }
    }

    #[test]
    fn quotes_and_unicode_survive_the_assignment() {
        // A translated string containing a quote must not end the JSON string,
        // and non-ASCII copy must reach the window intact.
        let copy = OfferCopy {
            version: "1.0.0",
            title: "L’application « Verboo » est prête",
            body: "She said \"yes\" — and it worked",
            install: "Télécharger",
            later: "Plus tard",
            close: "Fermer",
            failed: "Échec: \"quoted\"",
            diagnostic_label: "Code de diagnostic",
        };
        // Every statement shape the module emits, with its own decoder.
        let statements = [
            // Assignment form: strip the assignment, keep the value.
            copy_script(&copy),
            applied_script("a \"b\" c", "d « e »", "OK"),
            // Call form: strip the call wrapper, keep the single argument.
            fail_script("bad \"value\" and \\ backslash", "network"),
            running_script(&RunningCopy {
                title: "x \"y\"",
                body: "z",
                status: "s",
            }),
        ];
        for script in statements {
            assert!(!script.contains("\\\"undefined\\\""), "{script}");
            let json = if let Some((_, value)) = script.split_once(" = ") {
                value.trim_end_matches(';')
            } else if let Some(argument) = script.strip_prefix("window.__enterProgress(") {
                argument.trim_end_matches(");")
            } else {
                script
                    .strip_prefix("window.__fail(")
                    .expect("known statement")
                    .trim_end_matches(");")
            };
            // A successful parse is the assertion; the error case needs no closure.
            let parsed = serde_json::from_str::<serde_json::Value>(json);
            assert!(parsed.is_ok(), "unparseable payload {json}: {parsed:?}");
        }
    }

    #[test]
    fn a_version_with_a_quote_cannot_inject_a_statement() {
        let script = copy_script(&offer("1.0.0\"; alert(1); \""));
        assert!(!script.contains("alert(1); \""), "{script}");
        let json = script.split_once(" = ").unwrap().1.trim_end_matches(';');
        serde_json::from_str::<serde_json::Value>(json).expect("still valid JSON");
    }

    #[test]
    fn progress_reports_a_fraction_only_when_a_length_is_known() {
        assert_eq!(ratio_of(50, Some(100)), Some(0.5));
        assert_eq!(ratio_of(100, Some(100)), Some(1.0));
        assert_eq!(ratio_of(0, Some(100)), Some(0.0));
        // Overrun and unusable lengths clamp or report nothing rather than NaN.
        assert_eq!(ratio_of(150, Some(100)), Some(1.0));
        assert_eq!(ratio_of(10, Some(0)), None);
        assert_eq!(ratio_of(10, None), None);
        assert_eq!(ratio_of(usize::MAX, Some(1)), Some(1.0));
    }

    #[test]
    fn percentage_rounds_and_clamps() {
        assert_eq!(percent_of(0.0), 0);
        assert_eq!(percent_of(0.004), 0);
        assert_eq!(percent_of(0.005), 1);
        assert_eq!(percent_of(0.42), 42);
        assert_eq!(percent_of(0.999), 100);
        assert_eq!(percent_of(1.0), 100);
        assert_eq!(percent_of(-1.0), 0);
        assert_eq!(percent_of(2.0), 100);
        assert_eq!(percent_of(f64::NAN), 0);
    }

    #[test]
    fn progress_script_never_emits_nan_or_out_of_range() {
        assert_eq!(progress_script(f64::NAN), "window.__setProgress(0);");
        assert_eq!(progress_script(-0.5), "window.__setProgress(0);");
        assert_eq!(progress_script(1.5), "window.__setProgress(1);");
    }

    #[test]
    fn offering_skips_only_the_declined_version() {
        assert!(should_offer(None, "1.0.0"));
        assert!(should_offer(Some("0.9.0"), "1.0.0"));
        assert!(!should_offer(Some("1.0.0"), "1.0.0"));
        // A declined older version does not block a newer one.
        assert!(should_offer(Some("0.9.0"), "1.0.1"));
    }

    #[test]
    fn marker_and_window_names_stay_stable() {
        // The window labels are also the capability targets and the command guards.
        assert_eq!(UPDATE_WINDOW, "update");
        assert_eq!(UPDATED_WINDOW, "updated");
        assert_eq!(DECLINED_FILE, "update-declined");
        assert_eq!(APPLIED_FILE, "update-applied");
    }

    #[test]
    fn success_notice_requires_the_installed_target_to_be_running() {
        assert!(should_acknowledge("0.2.2-alpha.19", "0.2.2-alpha.19"));
        assert!(!should_acknowledge("0.2.2-alpha.19", "0.2.2-alpha.18"));
        assert!(!should_acknowledge("0.2.2-alpha.18", "0.2.2-alpha.19"));
        assert!(!should_acknowledge("", ""));
    }
}
