//! Optional desktop updates: check once per launch, download in the background,
//! stage the installer, and apply it.
//!
//! No window interrupts the product. The sidebar shows the download while it
//! runs, then a restart affordance once the installer is staged. A reader who
//! never answers still gets the update: the staged installer is applied on the
//! next launch. Every failure stays silent in the product — an unreachable feed
//! or a malformed manifest must never block startup.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Error as UpdateError, UpdaterExt};

use crate::update_logic as logic;

use logic::{APPLIED_FILE, DECLINED_FILE, STAGED_FILE, STAGED_PAYLOAD};

/// What the sidebar indicator renders. Serialized straight to the client.
#[derive(Clone, Default, serde::Serialize)]
pub struct UpdateStatus {
    /// `idle`, `checking`, `downloading`, `ready`, or `error`.
    phase: &'static str,
    /// Version the feed announced, once it did.
    version: Option<String>,
    /// Whole-percent progress while downloading.
    percent: Option<i64>,
    /// Stable diagnostic code, never provider text.
    failure: Option<&'static str>,
}

impl UpdateStatus {
    fn set(&mut self, next: UpdateStatus) {
        *self = next
    }
}

/// Owns the status the client polls and guards one download per launch.
#[derive(Default)]
pub struct UpdateRuntime {
    status: Mutex<UpdateStatus>,
    downloading: Mutex<bool>,
}

impl UpdateRuntime {
    fn publish(&self, next: UpdateStatus) {
        if let Ok(mut slot) = self.status.lock() {
            slot.set(next);
        }
    }

    fn snapshot(&self) -> UpdateStatus {
        self.status
            .lock()
            .map(|slot| slot.clone())
            .unwrap_or_default()
    }
}

fn config_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join(name))
}

fn read_marker(app: &AppHandle, name: &str) -> Option<String> {
    let path = config_file(app, name)?;
    std::fs::read_to_string(path)
        .ok()
        .map(|version| version.trim().to_string())
}

fn write_marker(app: &AppHandle, name: &str, version: &str) {
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

fn remove_file(app: &AppHandle, name: &str) {
    if let Some(path) = config_file(app, name) {
        let _ = std::fs::remove_file(path);
    }
}

/// Keep the downloaded installer for the next launch.
fn stage(app: &AppHandle, version: &str, bytes: &[u8]) -> bool {
    let Some(path) = config_file(app, STAGED_PAYLOAD) else {
        return false;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    if std::fs::write(&path, bytes).is_err() {
        eprintln!("Verboo Code: update_stage_failed");
        return false;
    }
    write_marker(app, STAGED_FILE, version);
    true
}

/// Read the installer kept by a previous launch.
fn staged(app: &AppHandle) -> Option<(String, Vec<u8>)> {
    let version = read_marker(app, STAGED_FILE)?;
    let path = config_file(app, STAGED_PAYLOAD)?;
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((version, bytes))
}

fn discard_staged(app: &AppHandle) {
    remove_file(app, STAGED_FILE);
    remove_file(app, STAGED_PAYLOAD);
}

/// Install one staged or freshly downloaded payload and restart into it.
fn install_and_restart(
    app: &AppHandle,
    version: &str,
    bytes: &[u8],
    update: &tauri_plugin_updater::Update,
) -> Result<(), UpdateError> {
    // Windows exits inside the installer call, before it can return success.
    // The next launch acknowledges this target only if it is actually running.
    write_marker(app, APPLIED_FILE, version);
    match update.install(bytes) {
        Ok(()) => {
            eprintln!("Verboo Code: update_installed");
            app.restart()
        }
        Err(error) => {
            remove_file(app, APPLIED_FILE);
            discard_staged(app);
            eprintln!(
                "Verboo Code: update_failed code={} detail={error}",
                update_failure_code(&error)
            );
            Err(error)
        }
    }
}

/// Check the feed, download what it announces, and stage the installer.
async fn check_and_download(app: AppHandle) {
    let runtime = app.state::<UpdateRuntime>();
    runtime.publish(UpdateStatus {
        phase: "checking",
        ..UpdateStatus::default()
    });
    let update = match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(update) => update,
            Err(error) => {
                eprintln!("Verboo Code: update_check_failed {error}");
                runtime.publish(UpdateStatus {
                    phase: "error",
                    failure: Some(update_failure_code(&error)),
                    ..UpdateStatus::default()
                });
                return;
            }
        },
        Err(error) => {
            eprintln!("Verboo Code: update_check_failed {error}");
            runtime.publish(UpdateStatus {
                phase: "error",
                failure: Some(update_failure_code(&error)),
                ..UpdateStatus::default()
            });
            return;
        }
    };
    let Some(update) = update else {
        runtime.publish(UpdateStatus {
            phase: "idle",
            ..UpdateStatus::default()
        });
        return;
    };
    let version = update.version.clone();
    if !logic::should_offer(read_marker(&app, DECLINED_FILE).as_deref(), &version) {
        runtime.publish(UpdateStatus {
            phase: "idle",
            ..UpdateStatus::default()
        });
        return;
    }
    {
        let Ok(mut guard) = runtime.downloading.lock() else {
            return;
        };
        if *guard {
            return;
        }
        *guard = true;
    }
    runtime.publish(UpdateStatus {
        phase: "downloading",
        version: Some(version.clone()),
        percent: Some(0),
        failure: None,
    });
    let progress_app = app.clone();
    let mut downloaded = 0usize;
    let mut reported = i64::MAX;
    let result = update
        .download(
            move |chunk: usize, total: Option<u64>| {
                downloaded += chunk;
                let Some(ratio) = logic::ratio_of(downloaded, total) else {
                    return;
                };
                let percent = logic::percent_of(ratio);
                if percent == reported {
                    return;
                }
                reported = percent;
                progress_app.state::<UpdateRuntime>().publish(UpdateStatus {
                    phase: "downloading",
                    version: None,
                    percent: Some(percent),
                    failure: None,
                });
            },
            || {},
        )
        .await;
    if let Ok(mut guard) = runtime.downloading.lock() {
        *guard = false;
    }
    match result {
        Ok(bytes) => {
            if stage(&app, &version, &bytes) {
                runtime.publish(UpdateStatus {
                    phase: "ready",
                    version: Some(version),
                    percent: None,
                    failure: None,
                });
            } else {
                runtime.publish(UpdateStatus {
                    phase: "error",
                    version: Some(version),
                    percent: None,
                    failure: Some("install-path"),
                });
            }
        }
        Err(error) => {
            eprintln!("Verboo Code: update_download_failed {error}");
            runtime.publish(UpdateStatus {
                phase: "error",
                version: Some(version),
                percent: None,
                failure: Some(update_failure_code(&error)),
            });
        }
    }
}

/// Apply an installer a previous launch staged, before anything else starts.
///
/// A staged installer whose version is not newer than the running one is
/// discarded: that launch already applied it.
fn apply_staged(app: &AppHandle) {
    let Some((version, bytes)) = staged(app) else {
        return;
    };
    let running = app.package_info().version.to_string();
    if !logic::should_acknowledge_newer(&version, &running) {
        discard_staged(app);
        return;
    }
    let Ok(updater) = app.updater() else {
        return;
    };
    let Ok(Some(update)) = tauri::async_runtime::block_on(updater.check()) else {
        // The feed no longer offers it; keep the staged copy for a later launch.
        return;
    };
    if update.version != version {
        discard_staged(app);
        return;
    }
    if let Err(error) = install_and_restart(app, &version, &bytes, &update) {
        eprintln!("Verboo Code: update_staged_install_failed {error}");
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
        UpdateError::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            "permission-denied"
        }
        UpdateError::Reqwest(_)
        | UpdateError::Http(_)
        | UpdateError::Network(_)
        | UpdateError::ReleaseNotFound => "network",
        UpdateError::TargetNotFound(_) | UpdateError::TargetsNotFound(_) => {
            "package-target-not-found"
        }
        UpdateError::FailedToDetermineExtractPath | UpdateError::TempDirNotFound => "install-path",
        UpdateError::BinaryNotFoundInArchive => "invalid-installer-format",
        UpdateError::PreviousAppNotRestored(_) => "rollback-failed",
        _ => "installation-failed",
    }
}

/// Report the current update state to the sidebar indicator.
#[tauri::command]
pub fn updates_status(state: State<'_, UpdateRuntime>) -> UpdateStatus {
    state.snapshot()
}

/// Restart into the staged installer the reader confirmed.
#[tauri::command]
pub async fn updates_restart(app: AppHandle) -> Result<(), String> {
    let Some((version, bytes)) = staged(&app) else {
        return Err("update_not_staged".into());
    };
    let Ok(updater) = app.updater() else {
        return Err("update_unavailable".into());
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        _ => return Err("update_unavailable".into()),
    };
    if update.version != version {
        discard_staged(&app);
        return Err("update_unavailable".into());
    }
    install_and_restart(&app, &version, &bytes, &update)
        .map_err(|error| update_failure_code(&error).to_string())
}

/// Remember that this reader dismissed the offer for one version.
#[tauri::command]
pub fn updates_dismiss(app: AppHandle, version: String) -> Result<(), String> {
    write_marker(&app, DECLINED_FILE, &version);
    app.state::<UpdateRuntime>().publish(UpdateStatus {
        phase: "idle",
        ..UpdateStatus::default()
    });
    Ok(())
}

/// Own the update state and apply whatever a previous launch staged.
pub fn install(app: &AppHandle) {
    app.manage(UpdateRuntime::default());
    apply_staged(app);
}

/// Check the feed once per launch, without holding up the product window.
pub fn spawn(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        tauri::async_runtime::block_on(check_and_download(app));
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
