//! Offer an available update in a product window, then install it in place.
//!
//! The window shows the download and states that the application restarts on its
//! own when the installation finishes, so the restart never surprises the user.
//! Every failure stays silent until the user is involved: an unreachable feed or
//! a malformed manifest must never block startup.

use crate::locale;
use crate::update_logic as logic;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_updater::{Error as UpdateError, Update, UpdaterExt};

use logic::{
    APPLIED_FILE, APPLIED_DWELL_MS, DECLINED_FILE, UPDATE_WINDOW, UPDATED_WINDOW,
};

fn config_file(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join(name))
}

fn read_marker(app: &tauri::AppHandle, name: &str) -> Option<String> {
    let path = config_file(app, name)?;
    std::fs::read_to_string(path)
        .ok()
        .map(|version| version.trim().to_string())
}

fn write_marker(app: &tauri::AppHandle, name: &str, version: &str) {
    let Some(path) = config_file(app, name) else {
        return;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if std::fs::write(path, version).is_err() {
        eprintln!("Verboo Code: update_marker_not_recorded");
    }
}

/// An update the feed offered and the user has not answered yet.
struct Prepared {
    version: String,
    update: Update,
}

/// The offered update, taken once when the user confirms the installation.
#[derive(Default)]
pub struct Offered(Mutex<Option<Prepared>>);

/// Open the offer window for a version the feed announced.
fn open_offer(app: &tauri::AppHandle, version: &str) -> tauri::Result<WebviewWindow> {
    let copy = locale::update_copy(version);
    let window = WebviewWindowBuilder::new(app, UPDATE_WINDOW, WebviewUrl::App("update.html".into()))
        .title("Verboo Code")
        .inner_size(468.0, 328.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .focused(true)
        .center()
        .initialization_script(&logic::copy_script(&logic::OfferCopy {
            version,
            title: &copy.title,
            body: &copy.body,
            install: &copy.install,
            later: &copy.later,
            close: &copy.close,
            failed: &copy.failed,
            diagnostic_label: &copy.diagnostic_label,
        }))
        .build()?;
    grant(app, UPDATE_WINDOW);
    Ok(window)
}

/// Check the feed once and offer what it announces.
async fn offer(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let version = update.version.clone();
    if !logic::should_offer(read_marker(&app, DECLINED_FILE).as_deref(), &version) {
        return Ok(());
    }
    if let Some(state) = app.try_state::<Offered>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(Prepared {
                version: version.clone(),
                update,
            });
        }
    }
    open_offer(&app, &version)?;
    Ok(())
}

/// Run the download the user confirmed, reporting its progress in the window.
#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, Offered>,
) -> Result<(), String> {
    if window.label() != UPDATE_WINDOW {
        return Err("update_install_denied".into());
    }
    let prepared = state.0.lock().ok().and_then(|mut slot| slot.take());
    let Some(Prepared { version, update }) = prepared else {
        return Err("update_install_unprepared".into());
    };
    let copy = locale::update_copy(&version);
    let _ = window.eval(logic::running_script(&logic::RunningCopy {
        title: &copy.running_title,
        body: &copy.running_body,
        status: &copy.status,
    }));

    // One eval per whole percent keeps the window responsive during a large download.
    let mut downloaded = 0usize;
    let mut reported = i64::MAX;
    let mut indeterminate = false;
    let progress_window = window.clone();
    let result = update
        .download_and_install(
            move |chunk: usize, total: Option<u64>| {
                downloaded += chunk;
                let Some(ratio) = logic::ratio_of(downloaded, total) else {
                    // A feed without a length still deserves motion, not a stalled bar.
                    if !indeterminate {
                        indeterminate = true;
                        let _ = progress_window.eval("window.__setIndeterminate()");
                    }
                    return;
                };
                let percent = logic::percent_of(ratio);
                if percent == reported {
                    return;
                }
                reported = percent;
                let _ = progress_window.eval(logic::progress_script(ratio));
            },
            || {},
        )
        .await;

    match result {
        Ok(()) => {
            // Record the version now running, so the next launch can say so once.
            write_marker(&app, APPLIED_FILE, &version);
            eprintln!("Verboo Code: update_installed");
            app.restart()
        }
        Err(error) => {
            let code = update_failure_code(&error);
            eprintln!("Verboo Code: update_failed code={code} detail={error}");
            let _ = window.eval(logic::fail_script(&copy.failed, code));
            Err(code.into())
        }
    }
}

/// Return a stable, safe diagnostic for the updater failure shown to the user.
fn update_failure_code(error: &UpdateError) -> &'static str {
    match error {
        UpdateError::InvalidUpdaterFormat => "invalid-installer-format",
        UpdateError::Minisign(_)
        | UpdateError::SignatureUtf8(_)
        | UpdateError::Base64(_)
        | UpdateError::SignedVersionMismatch { .. }
        | UpdateError::MissingSignedVersion => "signature-verification",
        UpdateError::AuthenticationFailed => "authentication-required",
        UpdateError::DebInstallFailed => "deb-install-failed",
        UpdateError::PackageInstallFailed => "package-install-failed",
        UpdateError::TempDirNotOnSameMountPoint => "filesystem-mount",
        UpdateError::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => "permission-denied",
        UpdateError::Reqwest(_)
        | UpdateError::Http(_)
        | UpdateError::Network(_)
        | UpdateError::ReleaseNotFound => "network",
        UpdateError::TargetNotFound(_) | UpdateError::TargetsNotFound(_) => "package-target-not-found",
        UpdateError::FailedToDetermineExtractPath | UpdateError::TempDirNotFound => "install-path",
        UpdateError::BinaryNotFoundInArchive => "invalid-installer-format",
        UpdateError::PreviousAppNotRestored(_) => "rollback-failed",
        _ => "installation-failed",
    }
}

/// Close an update window; declining the offer is remembered for that version.
#[tauri::command]
pub fn update_close(app: tauri::AppHandle, window: WebviewWindow, state: State<'_, Offered>) -> Result<(), String> {
    if window.label() != UPDATE_WINDOW && window.label() != UPDATED_WINDOW {
        return Err("update_close_denied".into());
    }
    if window.label() == UPDATE_WINDOW {
        if let Some(Prepared { version, .. }) = state.0.lock().ok().and_then(|mut slot| slot.take()) {
            write_marker(&app, DECLINED_FILE, &version);
        }
    }
    let _ = window.close();
    Ok(())
}

/// Say once that the running version came from the update installed last launch.
pub fn show_applied(app: &tauri::AppHandle) {
    let Some(version) = read_marker(app, APPLIED_FILE) else {
        return;
    };
    let Some(path) = config_file(app, APPLIED_FILE) else {
        return;
    };
    // The notice is one-shot even when the window cannot open.
    let _ = std::fs::remove_file(path);
    if version.is_empty() {
        return;
    }
    let (title, body) = locale::updated_copy(&version);
    let script = logic::applied_script(&title, &body, APPLIED_DWELL_MS);
    if WebviewWindowBuilder::new(app, UPDATED_WINDOW, WebviewUrl::App("updated.html".into()))
        .title("Verboo Code")
        .inner_size(428.0, 112.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .focused(false)
        .center()
        .initialization_script(&script)
        .build()
        .is_err()
    {
        eprintln!("Verboo Code: update_notice_unavailable");
    } else {
        grant(app, UPDATED_WINDOW);
    }
}

/// Grant one update window the two commands it may call.
fn grant(app: &tauri::AppHandle, label: &str) {
    use tauri::ipc::CapabilityBuilder;
    let capability = CapabilityBuilder::new(format!("update-window-{label}"))
        .local(false)
        .window(label)
        .permission("update-window");
    if app.add_capability(capability).is_err() {
        eprintln!("Verboo Code: update_capability_failed");
    }
}

/// Own the offered-update slot and show the notice for the previous install.
pub fn install(app: &tauri::AppHandle) {
    app.manage(Offered::default());
    show_applied(app);
}

/// Check the feed once per launch, without holding up the product window.
pub fn spawn(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = tauri::async_runtime::block_on(offer(app)) {
            eprintln!("Verboo Code: update_check_failed {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::update_failure_code;
    use tauri_plugin_updater::Error;

    #[test]
    fn updater_errors_map_to_safe_diagnostic_codes() {
        assert_eq!(
            update_failure_code(&Error::InvalidUpdaterFormat),
            "invalid-installer-format",
        );
        assert_eq!(
            update_failure_code(&Error::SignedVersionMismatch {
                signed: "1.0.0".into(),
                announced: "1.0.1".into(),
            }),
            "signature-verification",
        );
        assert_eq!(
            update_failure_code(&Error::Network("sensitive request detail".into())),
            "network",
        );
        assert_eq!(
            update_failure_code(&Error::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "private path",
            ))),
            "permission-denied",
        );
    }
}
