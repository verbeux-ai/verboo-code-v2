//! Download signed updates in the background and install a staged package on restart.
//!
//! The sidebar presents download progress and a deliberate restart action. Staged
//! packages are verified again before installation, including at the next launch.
//! Failures are reported without exposing package paths or credentials.

use crate::locale;
use crate::update_logic as logic;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Error as UpdateError, Update, Updater, UpdaterExt};

use logic::{APPLIED_FILE, DECLINED_FILE, UPDATED_WINDOW, UPDATE_WINDOW};

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

/// State projected to the owned main window without package metadata or paths.
#[derive(Clone, Debug, serde::Serialize)]
pub struct UpdateSnapshot {
    phase: &'static str,
    percent: Option<u8>,
}

struct Downloaded {
    update: Update,
}

/// Bytes for the one synchronous installation attempt, never kept by the background state.
struct PendingInstall {
    update: Update,
    bytes: Vec<u8>,
}

struct BackgroundInner {
    snapshot: UpdateSnapshot,
    downloaded: Option<Downloaded>,
    cache_lock: Option<File>,
    lifetime_lock: Option<File>,
}

/// One updater owner per process. The cache lock excludes another app instance.
pub struct Background(Mutex<BackgroundInner>);

impl Default for Background {
    fn default() -> Self {
        Self(Mutex::new(BackgroundInner {
            snapshot: UpdateSnapshot {
                phase: "idle",
                percent: None,
            },
            downloaded: None,
            cache_lock: None,
            lifetime_lock: None,
        }))
    }
}

const CACHE_DIR: &str = "pending-update";
const RECOVERY_MARKER: &str = "update-recovery-failed";
const CACHE_LIMIT: u64 = 512 * 1024 * 1024;
const LIFETIME_LOCK: &str = "running-instances.lock";
const INSTALL_GATE: &str = "update-install-gate.lock";
const VERIFICATION_GATE: &str = "update-verification.lock";
const SHARED_CACHE_POLL: std::time::Duration = std::time::Duration::from_secs(10);

fn open_coordination_lock(root: &Path, name: &str) -> Result<File, &'static str> {
    fs::create_dir_all(root).map_err(|_| "update_lock_unavailable")?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(root.join(name))
        .map_err(|_| "update_lock_unavailable")
}

/// Serializes startup and lock upgrades so no live Host becomes untracked.
#[cfg(test)]
fn lock_install_gate(root: &Path) -> Result<File, &'static str> {
    let gate = open_coordination_lock(root, INSTALL_GATE)?;
    gate.lock().map_err(|_| "update_lock_unavailable")?;
    Ok(gate)
}

fn lock_install_gate_with_wait(root: &Path, on_wait: impl FnOnce()) -> Result<File, &'static str> {
    let gate = open_coordination_lock(root, INSTALL_GATE)?;
    match gate.try_lock() {
        Ok(()) => (),
        Err(std::fs::TryLockError::WouldBlock) => {
            on_wait();
            gate.lock().map_err(|_| "update_lock_unavailable")?;
        }
        Err(std::fs::TryLockError::Error(_)) => return Err("update_lock_unavailable"),
    }
    Ok(gate)
}

/// A verifier skips a busy generation instead of buffering a second package.
fn try_verification_gate(root: &Path) -> Result<Option<File>, &'static str> {
    let gate = open_coordination_lock(root, VERIFICATION_GATE)?;
    match gate.try_lock() {
        Ok(()) => Ok(Some(gate)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(_)) => Err("update_lock_unavailable"),
    }
}

fn lock_verification_gate(root: &Path) -> Result<File, &'static str> {
    let gate = open_coordination_lock(root, VERIFICATION_GATE)?;
    gate.lock().map_err(|_| "update_lock_unavailable")?;
    Ok(gate)
}

enum ExclusiveLockFailure {
    /// The shared life lock was restored and installation may be retried later.
    Busy(File),
    /// Locking failed for a reason other than a competing instance.
    Unavailable(File),
    /// The life lock could not be confirmed and the app must not keep running.
    Untracked,
}

/// Gate ownership prevents another process from releasing its shared lock concurrently.
fn try_exclusive_lifetime(
    root: &Path,
    lifetime: File,
) -> Result<(File, File), ExclusiveLockFailure> {
    let gate = match open_coordination_lock(root, INSTALL_GATE) {
        Ok(gate) => gate,
        Err(_) => return Err(ExclusiveLockFailure::Unavailable(lifetime)),
    };
    match gate.try_lock() {
        Ok(()) => (),
        Err(std::fs::TryLockError::WouldBlock) => return Err(ExclusiveLockFailure::Busy(lifetime)),
        Err(std::fs::TryLockError::Error(_)) => {
            return Err(ExclusiveLockFailure::Unavailable(lifetime))
        }
    }
    if lifetime.unlock().is_err() {
        return Err(ExclusiveLockFailure::Untracked);
    }
    if let Err(error) = lifetime.try_lock() {
        return match lifetime.lock_shared() {
            Ok(()) if matches!(error, std::fs::TryLockError::WouldBlock) => {
                Err(ExclusiveLockFailure::Busy(lifetime))
            }
            Ok(()) => Err(ExclusiveLockFailure::Unavailable(lifetime)),
            Err(_) => Err(ExclusiveLockFailure::Untracked),
        };
    }
    Ok((gate, lifetime))
}

fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf, &'static str> {
    app.path()
        .app_cache_dir()
        .map_err(|_| "update_cache_unavailable")
}

// Locks must survive cache eviction: removing a locked file would let a new
// process lock a different inode and bypass the running instance.
fn coordination_root(app: &tauri::AppHandle) -> Result<PathBuf, &'static str> {
    app.path()
        .app_data_dir()
        .map(|root| root.join("update-coordination"))
        .map_err(|_| "update_lock_unavailable")
}

fn acquire_cache(app: &tauri::AppHandle) -> Result<(), &'static str> {
    let root = coordination_root(app)?;
    fs::create_dir_all(&root).map_err(|_| "update_cache_unavailable")?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(root.join("pending-update.lock"))
        .map_err(|_| "update_cache_unavailable")?;
    match lock.try_lock() {
        Ok(()) => (),
        Err(std::fs::TryLockError::WouldBlock) => return Err("update_cache_busy"),
        Err(std::fs::TryLockError::Error(_)) => return Err("update_cache_unavailable"),
    }
    let state = app.state::<Background>();
    state
        .0
        .lock()
        .map_err(|_| "update_state_unavailable")?
        .cache_lock = Some(lock);
    Ok(())
}

/// Write a complete generation before advertising it; incomplete writes are never loaded.
fn write_cache(
    root: &Path,
    metadata: &serde_json::Value,
    bytes: &[u8],
) -> Result<(), &'static str> {
    if bytes.len() as u64 > CACHE_LIMIT {
        return Err("update_cache_too_large");
    }
    let next = root.join("pending-update.tmp");
    let current = root.join(CACHE_DIR);
    if next.exists() {
        fs::remove_dir_all(&next).map_err(|_| "update_cache_unavailable")?;
    }
    fs::create_dir(&next).map_err(|_| "update_cache_unavailable")?;
    let result = (|| {
        fs::write(next.join("package"), bytes).map_err(|_| "update_cache_unavailable")?;
        let metadata = serde_json::to_vec(metadata).map_err(|_| "update_cache_invalid")?;
        if metadata.len() > 1024 * 1024 {
            return Err("update_cache_invalid");
        }
        fs::write(next.join("manifest.json"), metadata).map_err(|_| "update_cache_unavailable")?;
        if current.exists() {
            fs::remove_dir_all(&current).map_err(|_| "update_cache_unavailable")?;
        }
        fs::rename(&next, &current).map_err(|_| "update_cache_unavailable")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&next);
    }
    result
}

fn read_cache(root: &Path) -> Result<Option<(serde_json::Value, Vec<u8>)>, &'static str> {
    let dir = root.join(CACHE_DIR);
    if !dir.exists() {
        return Ok(None);
    }
    let manifest = dir.join("manifest.json");
    let package = dir.join("package");
    let metadata = read_bounded(&manifest, 1024 * 1024)?;
    let manifest = serde_json::from_slice(&metadata).map_err(|_| "update_cache_invalid")?;
    let bytes = read_bounded(&package, CACHE_LIMIT)?;
    Ok(Some((manifest, bytes)))
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, &'static str> {
    use std::io::Read;
    let file = File::open(path).map_err(|_| "update_cache_invalid")?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "update_cache_invalid")?;
    if bytes.len() as u64 > limit {
        return Err("update_cache_invalid");
    }
    Ok(bytes)
}

/// Re-read the staged package and verify it before stopping the running Host.
fn read_verified_package(root: &Path, update: &Update) -> Result<Vec<u8>, &'static str> {
    let bytes = read_bounded(&root.join(CACHE_DIR).join("package"), CACHE_LIMIT)?;
    update.verify(&bytes).map_err(|_| "update_cache_invalid")?;
    Ok(bytes)
}

/// Adopt an independently staged generation without retaining its package bytes.
fn read_verified_staged(
    root: &Path,
    updater: &Updater,
) -> Result<Option<Downloaded>, &'static str> {
    let Some((manifest, bytes)) = read_cache(root)? else {
        return Ok(None);
    };
    let Some(update) = updater
        .restore_update(manifest)
        .map_err(|_| "update_cache_invalid")?
    else {
        return Ok(None);
    };
    update.verify(&bytes).map_err(|_| "update_cache_invalid")?;
    drop(bytes);
    Ok(Some(Downloaded { update }))
}

#[derive(Debug, PartialEq, Eq)]
struct GenerationStamp {
    manifest: Vec<u8>,
    package_len: u64,
    package_modified: Option<std::time::SystemTime>,
}

/// Only reread the package when the committed generation changed.
fn generation_stamp(root: &Path) -> Result<Option<GenerationStamp>, &'static str> {
    let dir = root.join(CACHE_DIR);
    if !dir.try_exists().map_err(|_| "update_cache_invalid")? {
        return Ok(None);
    }
    let manifest = read_bounded(&dir.join("manifest.json"), 1024 * 1024)?;
    let package = fs::metadata(dir.join("package")).map_err(|_| "update_cache_invalid")?;
    if package.len() > CACHE_LIMIT {
        return Err("update_cache_invalid");
    }
    Ok(Some(GenerationStamp {
        manifest,
        package_len: package.len(),
        package_modified: package.modified().ok(),
    }))
}

fn set_snapshot(app: &tauri::AppHandle, phase: &'static str, percent: Option<u8>) {
    let snapshot = UpdateSnapshot { phase, percent };
    if let Some(state) = app.try_state::<Background>() {
        if let Ok(mut inner) = state.0.lock() {
            inner.snapshot = snapshot.clone();
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(json) = serde_json::to_string(&snapshot) {
            let _ = window.eval(format!(
                "window.dispatchEvent(new CustomEvent('verboo-update-state',{{detail:{json}}}))"
            ));
        }
    }
}

/// Snapshot for a main window that mounted after the most recent progress event.
#[tauri::command]
pub fn update_snapshot(
    window: WebviewWindow,
    host: State<'_, Arc<crate::HostState>>,
    state: State<'_, Background>,
) -> Result<UpdateSnapshot, String> {
    crate::owned_window(&window, &host)?;
    state
        .0
        .lock()
        .map(|inner| inner.snapshot.clone())
        .map_err(|_| "update_state_unavailable".into())
}

/// Persist the installation target before stopping the Host or touching the installed app.
fn write_recovery_marker_path(path: &Path, version: &str) -> Result<(), &'static str> {
    use std::io::Write;
    let parent = path.parent().ok_or("update_recovery_unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "update_recovery_unavailable")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "update_recovery_marker_exists"
            } else {
                "update_recovery_unavailable"
            }
        })?;
    file.write_all(version.as_bytes())
        .map_err(|_| "update_recovery_unavailable")?;
    file.sync_all().map_err(|_| "update_recovery_unavailable")?;
    // On Unix, persist the new directory entry as well as the file contents.
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "update_recovery_unavailable")?;
    Ok(())
}

fn write_recovery_marker(app: &tauri::AppHandle, version: &str) -> Result<(), &'static str> {
    let path = config_file(app, RECOVERY_MARKER).ok_or("update_recovery_unavailable")?;
    write_recovery_marker_path(&path, version)
}

/// A stale or unreadable marker is not evidence that the requested update was installed.
fn recovery_target_is_running(marker: &Path, running: &str) -> bool {
    read_bounded(marker, 256)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map(|target| !running.is_empty() && target.trim() == running)
        .unwrap_or(false)
}

/// A present but unreadable or different target cannot prove this process is current.
fn must_wait_for_update(marker: &Path, running: &str) -> bool {
    match marker.try_exists() {
        Ok(false) => false,
        Ok(true) => !recovery_target_is_running(marker, running),
        Err(_) => true,
    }
}

fn remove_recovery_marker(path: &Path) -> Result<(), &'static str> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("update_recovery_unavailable"),
    }
}

/// A failed rollback means the installed executable cannot be assumed to exist.
fn requires_manual_recovery(error: &UpdateError) -> bool {
    matches!(error, UpdateError::PreviousAppNotRestored(_))
}

/// Report an unrecovered bundle without attempting to start another Host or process.
fn show_rollback_failure(app: &tauri::AppHandle, host: &Arc<crate::HostState>) {
    host.quitting.store(true, Ordering::SeqCst);
    let app = app.clone();
    let host = Arc::clone(host);
    std::thread::spawn(move || {
        app.dialog()
            .message(locale::update_rollback_failure())
            .title("Verboo Code")
            .blocking_show();
        host.exit_ready.store(true, Ordering::SeqCst);
        app.exit(1);
    });
}

fn show_update_wait(app: &tauri::AppHandle, host: &Arc<crate::HostState>) {
    host.quitting.store(true, Ordering::SeqCst);
    let app = app.clone();
    let host = Arc::clone(host);
    std::thread::spawn(move || {
        app.dialog()
            .message(locale::update_wait())
            .title("Verboo Code")
            .blocking_show();
        host.exit_ready.store(true, Ordering::SeqCst);
        app.exit(1);
    });
}

fn confirm_closed_older_versions(app: &tauri::AppHandle) -> bool {
    let (message, confirm, cancel) = locale::update_confirm_closed();
    app.dialog()
        .message(message)
        .title("Verboo Code")
        .buttons(MessageDialogButtons::OkCancelCustom(
            confirm.into(),
            cancel.into(),
        ))
        .blocking_show()
}

/// Install a verified staged update after the owned Host has fully stopped.
#[tauri::command]
pub async fn update_restart(
    app: tauri::AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<crate::HostState>>,
    state: State<'_, Background>,
) -> Result<(), String> {
    crate::owned_window(&window, &host)?;
    let downloaded = {
        let mut inner = state.0.lock().map_err(|_| "update_state_unavailable")?;
        if inner.snapshot.phase != "ready" {
            return Err("update_not_ready".into());
        }
        inner.snapshot = UpdateSnapshot {
            phase: "installing",
            percent: None,
        };
        inner.downloaded.take().ok_or("update_not_ready")?
    };
    let confirm_app = app.clone();
    let confirmed =
        tauri::async_runtime::spawn_blocking(move || confirm_closed_older_versions(&confirm_app))
            .await
            .unwrap_or(false);
    if !confirmed {
        let mut inner = state.0.lock().map_err(|_| "update_state_unavailable")?;
        inner.downloaded = Some(downloaded);
        drop(inner);
        set_snapshot(&app, "ready", Some(100));
        return Err("update_confirmation_cancelled".into());
    }
    let (_verification, bytes) = match cache_root(&app).and_then(|root| {
        let gate = lock_verification_gate(&coordination_root(&app)?)?;
        let bytes = read_verified_package(&root, &downloaded.update)?;
        Ok((gate, bytes))
    }) {
        Ok(result) => result,
        Err(code) => {
            set_snapshot(&app, "error", None);
            return Err(code.into());
        }
    };
    if host
        .quitting
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        let mut inner = state.0.lock().map_err(|_| "update_state_unavailable")?;
        inner.downloaded = Some(downloaded);
        inner.snapshot = UpdateSnapshot {
            phase: "ready",
            percent: Some(100),
        };
        drop(inner);
        set_snapshot(&app, "ready", Some(100));
        return Err("update_busy".into());
    }
    if let Err(code) = write_recovery_marker(&app, &downloaded.update.version) {
        // No Host or installer operation has begun. Clear any partial marker
        // before offering the still-verified package again.
        host.quitting.store(false, Ordering::SeqCst);
        let cleared = code != "update_recovery_marker_exists"
            && config_file(&app, RECOVERY_MARKER)
                .is_some_and(|path| remove_recovery_marker(&path).is_ok());
        if cleared {
            let mut inner = state.0.lock().map_err(|_| "update_state_unavailable")?;
            inner.downloaded = Some(downloaded);
            drop(inner);
            set_snapshot(&app, "ready", Some(100));
        } else {
            set_snapshot(&app, "error", None);
        }
        return Err(code.into());
    }
    let lifetime = state
        .0
        .lock()
        .map_err(|_| "update_state_unavailable")?
        .lifetime_lock
        .take();
    let Some(lifetime) = lifetime else {
        set_snapshot(&app, "error", None);
        crate::startup_failure(&app, &host, "update_lock_unavailable");
        return Err("update_lock_unavailable".into());
    };
    let root = match coordination_root(&app) {
        Ok(root) => root,
        Err(code) => {
            // The current shared lock remains live; no installer can enter.
            let mut inner = state.0.lock().map_err(|_| "update_state_unavailable")?;
            inner.lifetime_lock = Some(lifetime);
            inner.downloaded = Some(downloaded);
            drop(inner);
            host.quitting.store(false, Ordering::SeqCst);
            set_snapshot(&app, "error", None);
            return Err(code.into());
        }
    };
    let _exclusive = match try_exclusive_lifetime(&root, lifetime) {
        Ok(guard) => guard,
        Err(failure @ (ExclusiveLockFailure::Busy(_) | ExclusiveLockFailure::Unavailable(_))) => {
            let (lifetime, code) = match failure {
                ExclusiveLockFailure::Busy(file) => (file, "update_other_instance_active"),
                ExclusiveLockFailure::Unavailable(file) => (file, "update_lock_unavailable"),
                ExclusiveLockFailure::Untracked => unreachable!(),
            };
            let mut inner = state.0.lock().map_err(|_| "update_state_unavailable")?;
            inner.lifetime_lock = Some(lifetime);
            inner.downloaded = Some(downloaded);
            drop(inner);
            host.quitting.store(false, Ordering::SeqCst);
            let cleared = config_file(&app, RECOVERY_MARKER)
                .is_some_and(|path| remove_recovery_marker(&path).is_ok());
            if cleared {
                set_snapshot(&app, "ready", Some(100));
            } else {
                set_snapshot(&app, "error", None);
            }
            return Err(code.into());
        }
        Err(ExclusiveLockFailure::Untracked) => {
            // A Host must not remain live without a confirmed lifetime lock.
            set_snapshot(&app, "error", None);
            crate::startup_failure(&app, &host, "update_lock_unavailable");
            return Err("update_lock_unavailable".into());
        }
    };
    set_snapshot(&app, "installing", None);
    let host = Arc::clone(&host);
    let stop_host = Arc::clone(&host);
    let stopped = tauri::async_runtime::spawn_blocking(move || stop_host.stop()).await;
    if !matches!(stopped, Ok(Ok(()))) {
        set_snapshot(&app, "error", None);
        // An unconfirmed Host shutdown must never be followed by installation or a new Host.
        crate::startup_failure(&app, &host, "update_host_shutdown_failed");
        return Err("update_host_shutdown_failed".into());
    }
    write_marker(&app, APPLIED_FILE, &downloaded.update.version);
    match downloaded.update.install(&bytes) {
        Ok(()) => {
            if let Ok(root) = cache_root(&app) {
                let _ = fs::remove_dir_all(root.join(CACHE_DIR));
            }
            // Keep the durable target until the new version itself starts.
            host.exit_ready.store(true, Ordering::SeqCst);
            app.request_restart();
            Ok(())
        }
        Err(error) => {
            if let Some(path) = config_file(&app, APPLIED_FILE) {
                let _ = fs::remove_file(path);
            }
            let code = update_failure_code(&error);
            eprintln!("Verboo Code: staged_update_failed {code}");
            if requires_manual_recovery(&error) {
                set_snapshot(&app, "error", None);
                show_rollback_failure(&app, &host);
                return Err(code.into());
            }
            // The prewritten marker suppresses another installation on recovery.
            host.exit_ready.store(true, Ordering::SeqCst);
            app.request_restart();
            Ok(())
        }
    }
}

/// Retire only the failed staged generation. Keep the marker until cleanup succeeds.
fn retire_failed_cache(root: &Path, marker: Option<&Path>) -> Result<(), &'static str> {
    let generation = root.join(CACHE_DIR);
    match fs::remove_dir_all(generation) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err("update_cache_unavailable"),
    }
    if let Some(marker) = marker {
        match fs::remove_file(marker) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("update_cache_unavailable"),
        }
    }
    Ok(())
}

/// Register this process before it may start a Host, and install only with exclusive ownership.
/// Returns an error rather than allowing an untracked Host to run.
pub fn install_pending(
    app: &tauri::AppHandle,
    on_wait: impl FnOnce(),
    continue_after_wait: impl FnOnce() -> bool,
) -> Result<bool, &'static str> {
    let root = coordination_root(app)?;
    let _gate = lock_install_gate_with_wait(&root, on_wait)?;
    if !continue_after_wait() {
        return Ok(true);
    }
    let marker = config_file(app, RECOVERY_MARKER).ok_or("update_recovery_unavailable")?;
    if must_wait_for_update(&marker, &app.package_info().version.to_string()) {
        show_update_wait(app, &app.state::<Arc<crate::HostState>>());
        return Ok(true);
    }
    let lifetime = open_coordination_lock(&root, LIFETIME_LOCK)?;
    let exclusive = lifetime.try_lock().is_ok();
    if exclusive && install_pending_inner(app) {
        return Ok(true);
    }
    // No Host can start until the shared lock is acquired. The gate prevents
    // an installer from entering while an exclusive lock is downgraded. Unlock
    // first because recursive lock conversion is not portable across platforms.
    if exclusive {
        lifetime.unlock().map_err(|_| "update_lock_unavailable")?;
    }
    lifetime
        .lock_shared()
        .map_err(|_| "update_lock_unavailable")?;
    app.state::<Background>()
        .0
        .lock()
        .map_err(|_| "update_state_unavailable")?
        .lifetime_lock = Some(lifetime);
    Ok(false)
}

/// Install a previously verified cache before starting the Host, including without network.
fn install_pending_inner(app: &tauri::AppHandle) -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    if let Err(code) = acquire_cache(app) {
        if code != "update_cache_busy" {
            set_snapshot(app, "error", None);
        }
        return false;
    }
    let Some(marker) = config_file(app, RECOVERY_MARKER) else {
        set_snapshot(app, "error", None);
        return false;
    };
    match marker.try_exists() {
        Ok(true) => {
            let installed =
                recovery_target_is_running(&marker, &app.package_info().version.to_string());
            if cache_root(app)
                .and_then(|root| retire_failed_cache(&root, Some(&marker)))
                .is_err()
            {
                eprintln!("Verboo Code: update_cache_unavailable");
                set_snapshot(app, "error", None);
                return false;
            }
            if !installed {
                set_snapshot(app, "error", None);
            }
            return false;
        }
        Err(_) => {
            set_snapshot(app, "error", None);
            return false;
        }
        Ok(false) => (),
    }
    let result = (|| -> Result<Option<PendingInstall>, &'static str> {
        let root = cache_root(app)?;
        let Some((manifest, bytes)) = read_cache(&root)? else {
            return Ok(None);
        };
        let updater = app.updater().map_err(|_| "update_cache_invalid")?;
        let Some(update) = updater
            .restore_update(manifest)
            .map_err(|_| "update_cache_invalid")?
        else {
            fs::remove_dir_all(root.join(CACHE_DIR)).map_err(|_| "update_cache_unavailable")?;
            return Ok(None);
        };
        update.verify(&bytes).map_err(|_| "update_cache_invalid")?;
        Ok(Some(PendingInstall { update, bytes }))
    })();
    match result {
        Ok(Some(downloaded)) => {
            // install_pending runs off the UI thread so the native dialog can respond.
            // A cancellation leaves the verified staged generation untouched.
            if !confirm_closed_older_versions(app) {
                return false;
            }
            if write_recovery_marker(app, &downloaded.update.version).is_err() {
                set_snapshot(app, "error", None);
                return false;
            }
            write_marker(app, APPLIED_FILE, &downloaded.update.version);
            match downloaded.update.install(&downloaded.bytes) {
                Ok(()) => {
                    if let Ok(root) = cache_root(app) {
                        let _ = fs::remove_dir_all(root.join(CACHE_DIR));
                    }
                    // The target process acknowledges and clears this marker.
                    app.restart()
                }
                Err(error) => {
                    if let Some(path) = config_file(app, APPLIED_FILE) {
                        let _ = fs::remove_file(path);
                    }
                    eprintln!(
                        "Verboo Code: staged_update_failed {}",
                        update_failure_code(&error)
                    );
                    if requires_manual_recovery(&error) {
                        set_snapshot(app, "error", None);
                        let host = app.state::<Arc<crate::HostState>>();
                        show_rollback_failure(app, &host);
                        return true;
                    }
                    let cleanup =
                        cache_root(app).and_then(|root| retire_failed_cache(&root, Some(&marker)));
                    if cleanup.is_err() {
                        eprintln!("Verboo Code: update_recovery_unavailable");
                    }
                    set_snapshot(app, "error", None);
                    false
                }
            }
        }
        Ok(None) => false,
        Err(code) => {
            eprintln!("Verboo Code: {code}");
            if code == "update_cache_invalid" {
                if let Ok(root) = cache_root(app) {
                    let _ = retire_failed_cache(&root, None);
                }
            }
            set_snapshot(app, "error", None);
            false
        }
    }
}

async fn download_in_background(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Background>();
    if state
        .0
        .lock()
        .map_err(|_| "update_state_unavailable")?
        .cache_lock
        .is_none()
    {
        return Ok(());
    }
    if state
        .0
        .lock()
        .map_err(|_| "update_state_unavailable")?
        .snapshot
        .phase
        == "error"
    {
        return Ok(());
    }
    let Some(update) = app
        .updater()
        .map_err(|_| "update_check_failed")?
        .check()
        .await
        .map_err(|_| "update_check_failed")?
    else {
        return Ok(());
    };
    let root = cache_root(&app)?;
    // Keep observers from allocating a second package while download and staging
    // hold the updater's package buffer in this process.
    let verification = lock_verification_gate(&coordination_root(&app)?)?;
    set_snapshot(&app, "downloading", None);
    let mut downloaded = 0usize;
    let mut last = None;
    let progress_app = app.clone();
    let bytes = update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk);
                let percent =
                    logic::ratio_of(downloaded, total).map(|ratio| logic::percent_of(ratio) as u8);
                if percent != last {
                    last = percent;
                    set_snapshot(&progress_app, "downloading", percent);
                }
            },
            || {},
        )
        .await
        .map_err(|error| update_failure_code(&error).to_string())?;
    write_cache(&root, &update.raw_json, &bytes)?;
    drop(bytes);
    drop(verification);
    state
        .0
        .lock()
        .map_err(|_| "update_state_unavailable")?
        .downloaded = Some(Downloaded { update });
    set_snapshot(&app, "ready", Some(100));
    Ok(())
}

enum CacheAdoption {
    /// Another process currently holds package bytes for download or verification.
    Busy,
    /// No new valid generation was present.
    NoNew,
    Ready,
}

/// Read a committed generation only once, with one package buffer across instances.
fn try_adopt_cache(
    app: &tauri::AppHandle,
    last: &mut Option<GenerationStamp>,
) -> Result<CacheAdoption, &'static str> {
    let root = cache_root(app)?;
    let Some(verification) = try_verification_gate(&coordination_root(app)?)? else {
        return Ok(CacheAdoption::Busy);
    };
    let Some(stamp) = generation_stamp(&root)? else {
        *last = None;
        return Ok(CacheAdoption::NoNew);
    };
    if last.as_ref() == Some(&stamp) {
        return Ok(CacheAdoption::NoNew);
    }
    *last = Some(stamp);
    let updater = app.updater().map_err(|_| "update_cache_invalid")?;
    let Some(downloaded) = read_verified_staged(&root, &updater)? else {
        return Ok(CacheAdoption::NoNew);
    };
    app.state::<Background>()
        .0
        .lock()
        .map_err(|_| "update_state_unavailable")?
        .downloaded = Some(downloaded);
    drop(verification);
    set_snapshot(app, "ready", Some(100));
    Ok(CacheAdoption::Ready)
}

/// Secondary instances adopt new cache generations or take over one feed check.
fn monitor_or_download(app: tauri::AppHandle) -> Result<(), String> {
    let host = Arc::clone(&app.state::<Arc<crate::HostState>>());
    let mut last = None;
    loop {
        if host.quitting.load(Ordering::SeqCst) {
            std::thread::sleep(SHARED_CACHE_POLL);
            continue;
        }
        let is_idle = app
            .state::<Background>()
            .0
            .lock()
            .map_err(|_| "update_state_unavailable")?
            .snapshot
            .phase
            == "idle";
        if !is_idle {
            return Ok(());
        }
        match try_adopt_cache(&app, &mut last)? {
            CacheAdoption::Ready => return Ok(()),
            CacheAdoption::Busy => {
                std::thread::sleep(SHARED_CACHE_POLL);
                continue;
            }
            CacheAdoption::NoNew => (),
        }
        let owns_cache = app
            .state::<Background>()
            .0
            .lock()
            .map_err(|_| "update_state_unavailable")?
            .cache_lock
            .is_some();
        if owns_cache {
            return tauri::async_runtime::block_on(download_in_background(app));
        }
        match acquire_cache(&app) {
            Ok(()) => continue, // Recheck staging after acquiring the lock before any network call.
            Err("update_cache_busy") => std::thread::sleep(SHARED_CACHE_POLL),
            Err(code) => return Err(code.into()),
        }
    }
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
    let finalizing_window = window.clone();
    let finalizing_status = copy.finalizing_status.clone();
    let marker_app = app.clone();
    let marker_version = version.clone();
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
            move || {
                let _ = finalizing_window.eval(&logic::finalizing_script(&finalizing_status));
                // Windows exits inside the installer call, before it can return success.
                // The next launch acknowledges this target only if it is actually running.
                write_marker(&marker_app, APPLIED_FILE, &marker_version);
            },
        )
        .await;

    match result {
        Ok(()) => {
            eprintln!("Verboo Code: update_installed");
            app.restart()
        }
        Err(error) => {
            if let Some(path) = config_file(&app, APPLIED_FILE) {
                let _ = std::fs::remove_file(path);
            }
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

/// Close an update window; declining the offer is remembered for that version.
#[tauri::command]
pub fn update_close(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, Offered>,
) -> Result<(), String> {
    if window.label() != UPDATE_WINDOW && window.label() != UPDATED_WINDOW {
        return Err("update_close_denied".into());
    }
    if window.label() == UPDATE_WINDOW {
        if let Some(Prepared { version, .. }) = state.0.lock().ok().and_then(|mut slot| slot.take())
        {
            write_marker(&app, DECLINED_FILE, &version);
        }
    }
    window.close().map_err(|_| "update_close_failed".into())
}

/// Retire the applied marker when the running version matches the target.
pub fn show_applied(app: &tauri::AppHandle) {
    let Some(version) = read_marker(app, APPLIED_FILE) else { return; };
    if logic::should_acknowledge(&version, &app.package_info().version.to_string()) {
        if let Some(path) = config_file(app, APPLIED_FILE) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Own the offered-update slot and background updater state.
pub fn install(app: &tauri::AppHandle) {
    app.manage(Offered::default());
    app.manage(Background::default());
}

/// Check the feed once per launch, without holding up the product window.
pub fn spawn(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = monitor_or_download(app.clone()) {
            eprintln!("Verboo Code: update_background_failed {error}");
            set_snapshot(&app, "error", None);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        generation_stamp, lock_install_gate, lock_install_gate_with_wait, lock_verification_gate,
        must_wait_for_update, open_coordination_lock, read_cache, read_verified_package,
        read_verified_staged, recovery_target_is_running, remove_recovery_marker,
        requires_manual_recovery, retire_failed_cache, try_exclusive_lifetime,
        try_verification_gate, update_failure_code, write_cache, write_recovery_marker_path,
        ExclusiveLockFailure, INSTALL_GATE, LIFETIME_LOCK,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);
    fn cache_test_root() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "verboo-update-cache-test-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn cached_signed_release_is_verified_offline_and_tampering_is_rejected() {
        use tauri_plugin_updater::UpdaterExt;
        // Public throwaway vector from tauri-plugin-updater's offline tests.
        const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEE0OUVGNDc0NkZBNkU2RDcKUldUWDVxWnZkUFNlcERHV2cyYno4bjZBclFuQk13Z1FLMWdlVm9zb3JjYkx6Y3VuRCtLSitjWWU=";
        const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUWDVxWnZkUFNlcFBGMnpzanZQL0wvVFF0QkxSbldSdmFxKzRvbUsxVUV1Z3RRcC9VU3JHaUkxdjc2MnNEeTNpZDNhb3I3YlJDOUVUeWVvdDZsTUhIcldvWjVoalVNMVFjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNjQ5MDUxCWZpbGU6cGF5bG9hZAl2ZXJzaW9uOjIuMC4wCkREcTJDTE9FbDVjUW1DMmVKUkhsblpQVlZpT1pzdTFDanBQS1FvZWk0QS9YQmZrRHFHTzBCK1FNcmNySGdFUTVxVjNtbmU3NXRkRldoSnBxVVhoOUFBPT0=";
        let root = cache_test_root();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), serde_json::json!({ "pubkey": KEY }));
        let app = tauri::test::mock_builder()
            .plugin(
                tauri_plugin_updater::Builder::new()
                    .target("test-target")
                    .build(),
            )
            .build(context)
            .unwrap();
        let updater = app
            .updater_builder()
            .executable_path(root.join("application"))
            .endpoints(vec!["https://example.invalid/update".parse().unwrap()])
            .unwrap()
            .build()
            .unwrap();
        let manifest = serde_json::json!({
            "version": "2.0.0",
            "platforms": { "test-target": { "url": "https://example.invalid/package", "signature": SIGNATURE } }
        });
        write_cache(&root, &manifest, b"test").unwrap();
        let (saved, package) = read_cache(&root).unwrap().unwrap();
        let update = updater.restore_update(saved.clone()).unwrap().unwrap();
        update.verify(&package).unwrap();
        assert_eq!(read_verified_package(&root, &update).unwrap(), b"test");
        assert_eq!(
            read_verified_staged(&root, &updater)
                .unwrap()
                .unwrap()
                .update
                .version,
            "2.0.0"
        );
        assert!(update.verify(b"tampered").is_err());
        std::fs::write(root.join("pending-update/package"), b"tampered").unwrap();
        assert_eq!(
            read_verified_package(&root, &update).unwrap_err(),
            "update_cache_invalid"
        );
        assert!(matches!(
            read_verified_staged(&root, &updater),
            Err("update_cache_invalid")
        ));
        let (saved, tampered) = read_cache(&root).unwrap().unwrap();
        assert!(updater
            .restore_update(saved)
            .unwrap()
            .unwrap()
            .verify(&tampered)
            .is_err());
        let mut wrong_version = manifest;
        wrong_version["version"] = serde_json::json!("3.0.0");
        let error = updater
            .restore_update(wrong_version)
            .unwrap()
            .unwrap()
            .verify(b"test")
            .unwrap_err();
        assert!(matches!(
            error,
            tauri_plugin_updater::Error::SignedVersionMismatch { .. }
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_round_trips_manifest_and_package_without_network() {
        let root = cache_test_root();
        let manifest = serde_json::json!({"version":"2.0.0", "signature":"signed"});
        write_cache(&root, &manifest, b"signed bytes").unwrap();
        let (saved, package) = read_cache(&root).unwrap().unwrap();
        assert_eq!(saved, manifest);
        assert_eq!(package, b"signed bytes");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_or_corrupt_generation_never_counts_as_ready() {
        let root = cache_test_root();
        std::fs::create_dir(root.join("pending-update.tmp")).unwrap();
        std::fs::write(root.join("pending-update.tmp/package"), b"partial").unwrap();
        assert!(read_cache(&root).unwrap().is_none());
        std::fs::create_dir(root.join("pending-update")).unwrap();
        std::fs::write(root.join("pending-update/package"), b"partial").unwrap();
        assert_eq!(read_cache(&root).unwrap_err(), "update_cache_invalid");
        std::fs::write(root.join("pending-update/manifest.json"), b"{").unwrap();
        assert_eq!(read_cache(&root).unwrap_err(), "update_cache_invalid");
        std::fs::write(
            root.join("pending-update/manifest.json"),
            vec![b' '; 1024 * 1024 + 1],
        )
        .unwrap();
        assert_eq!(read_cache(&root).unwrap_err(), "update_cache_invalid");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn committed_generation_stamp_changes_only_when_staged_content_changes() {
        let root = cache_test_root();
        assert!(generation_stamp(&root).unwrap().is_none());
        write_cache(&root, &serde_json::json!({"version":"1"}), b"package").unwrap();
        let first = generation_stamp(&root).unwrap().unwrap();
        assert_eq!(generation_stamp(&root).unwrap().unwrap(), first);
        write_cache(&root, &serde_json::json!({"version":"2"}), b"package").unwrap();
        assert_ne!(generation_stamp(&root).unwrap().unwrap(), first);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verification_gate_prevents_concurrent_package_buffers() {
        let root = cache_test_root();
        let owner = lock_verification_gate(&root).unwrap();
        assert!(try_verification_gate(&root).unwrap().is_none());
        drop(owner);
        assert!(try_verification_gate(&root).unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_generation_replaces_complete_old_generation() {
        let root = cache_test_root();
        write_cache(&root, &serde_json::json!({"version":"1"}), b"old").unwrap();
        write_cache(&root, &serde_json::json!({"version":"2"}), b"new").unwrap();
        let (manifest, package) = read_cache(&root).unwrap().unwrap();
        assert_eq!(manifest["version"], "2");
        assert_eq!(package, b"new");
        assert!(!root.join("pending-update.tmp").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    use tauri_plugin_updater::Error;

    #[test]
    fn failed_generation_is_retired_without_deleting_other_cache_files() {
        let root = cache_test_root();
        let marker = root.join("update-recovery-failed");
        std::fs::write(&marker, b"installation-failed").unwrap();
        std::fs::write(root.join("unrelated"), b"keep").unwrap();
        write_cache(&root, &serde_json::json!({"version":"1"}), b"bad").unwrap();
        retire_failed_cache(&root, Some(&marker)).unwrap();
        assert!(read_cache(&root).unwrap().is_none());
        assert!(!marker.exists());
        assert_eq!(std::fs::read(root.join("unrelated")).unwrap(), b"keep");
        retire_failed_cache(&root, None).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_marker_distinguishes_interrupted_install_from_completed_target() {
        let root = cache_test_root();
        let marker = root.join("recovery/marker");
        write_cache(&root, &serde_json::json!({"version":"2.0.0"}), b"package").unwrap();
        write_recovery_marker_path(&marker, "2.0.0").unwrap();
        assert_eq!(
            write_recovery_marker_path(&marker, "3.0.0").unwrap_err(),
            "update_recovery_marker_exists"
        );
        assert!(!recovery_target_is_running(&marker, "1.0.0"));
        assert!(recovery_target_is_running(&marker, "2.0.0"));
        assert!(!recovery_target_is_running(&marker, ""));
        retire_failed_cache(&root, Some(&marker)).unwrap();
        assert!(read_cache(&root).unwrap().is_none());
        assert!(!marker.exists());
        remove_recovery_marker(&marker).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_marker_failure_leaves_staged_package_untouched() {
        let root = cache_test_root();
        write_cache(&root, &serde_json::json!({"version":"2.0.0"}), b"package").unwrap();
        let blocker = root.join("not-a-directory");
        std::fs::write(&blocker, b"file").unwrap();
        let marker = blocker.join("marker");
        assert_eq!(
            write_recovery_marker_path(&marker, "2.0.0").unwrap_err(),
            "update_recovery_unavailable"
        );
        assert_eq!(read_cache(&root).unwrap().unwrap().1, b"package");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn waiting_startup_reports_gate_contention_then_rechecks_after_release() {
        let root = cache_test_root();
        let held = lock_install_gate(&root).unwrap();
        let marker = root.join("recovery");
        write_recovery_marker_path(&marker, "2.0.0").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let waiter_root = root.clone();
        let waiter = std::thread::spawn(move || {
            let _gate =
                lock_install_gate_with_wait(&waiter_root, || sender.send(()).unwrap()).unwrap();
            must_wait_for_update(&waiter_root.join("recovery"), "1.0.0")
        });
        receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        drop(held);
        assert!(waiter.join().unwrap());
        assert!(marker.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn waiting_process_cannot_start_old_host_or_clear_ambiguous_marker() {
        let root = cache_test_root();
        let marker = root.join("recovery");
        assert!(!must_wait_for_update(&marker, "1.0.0"));
        write_recovery_marker_path(&marker, "2.0.0").unwrap();
        assert!(must_wait_for_update(&marker, "1.0.0"));
        assert!(marker.exists());
        assert!(!must_wait_for_update(&marker, "2.0.0"));
        std::fs::write(&marker, b"\xff").unwrap();
        assert!(must_wait_for_update(&marker, "2.0.0"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_cleanup_does_not_release_persistent_coordination_locks() {
        let root = cache_test_root();
        let cache = root.join("cache");
        let coordination = root.join("data").join("update-coordination");
        std::fs::create_dir_all(&cache).unwrap();
        let active = open_coordination_lock(&coordination, LIFETIME_LOCK).unwrap();
        active.lock_shared().unwrap();
        std::fs::remove_dir_all(&cache).unwrap();
        let contender = open_coordination_lock(&coordination, LIFETIME_LOCK).unwrap();
        assert!(contender.try_lock().is_err());
        drop(active);
        contender.try_lock().unwrap();
        drop(contender);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_instances_block_install_and_gate_blocks_new_instance_during_install() {
        let root = cache_test_root();
        let first = open_coordination_lock(&root, LIFETIME_LOCK).unwrap();
        let second = open_coordination_lock(&root, LIFETIME_LOCK).unwrap();
        first.lock_shared().unwrap();
        second.lock_shared().unwrap();
        let first = match try_exclusive_lifetime(&root, first) {
            Err(ExclusiveLockFailure::Busy(shared)) => shared,
            _ => panic!("a second live instance must prevent installation"),
        };
        let probe = open_coordination_lock(&root, LIFETIME_LOCK).unwrap();
        assert!(
            probe.try_lock().is_err(),
            "the rejected upgrader must retain its shared lock"
        );
        drop(probe);
        drop(second);
        let (gate, exclusive) = match try_exclusive_lifetime(&root, first) {
            Ok(guard) => guard,
            _ => panic!("the last instance should obtain exclusive installation ownership"),
        };
        let arriving_gate = open_coordination_lock(&root, INSTALL_GATE).unwrap();
        let arriving_lifetime = open_coordination_lock(&root, LIFETIME_LOCK).unwrap();
        assert!(
            arriving_gate.try_lock().is_err(),
            "a new Host cannot pass the gate during installation"
        );
        assert!(
            arriving_lifetime.try_lock_shared().is_err(),
            "a new Host cannot hold a shared lock during installation"
        );
        drop(exclusive);
        drop(gate);
        arriving_gate.try_lock().unwrap();
        arriving_lifetime.try_lock_shared().unwrap();
        drop(arriving_gate);
        drop(arriving_lifetime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn simultaneous_upgrade_keeps_the_losing_instance_registered() {
        let root = cache_test_root();
        let first_gate = lock_install_gate(&root).unwrap();
        let lifetime = open_coordination_lock(&root, LIFETIME_LOCK).unwrap();
        lifetime.lock_shared().unwrap();
        let lifetime = match try_exclusive_lifetime(&root, lifetime) {
            Err(ExclusiveLockFailure::Busy(shared)) => shared,
            _ => panic!("the competing gate must reject another installer"),
        };
        drop(first_gate);
        let other = open_coordination_lock(&root, LIFETIME_LOCK).unwrap();
        assert!(
            other.try_lock().is_err(),
            "the rejected instance still owns a shared lock"
        );
        drop(other);
        drop(lifetime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn recovery_marker_does_not_follow_an_existing_symlink() {
        let root = cache_test_root();
        let target = root.join("keep");
        let marker = root.join("marker");
        std::fs::write(&target, b"keep").unwrap();
        std::os::unix::fs::symlink(&target, &marker).unwrap();
        assert_eq!(
            write_recovery_marker_path(&marker, "2.0.0").unwrap_err(),
            "update_recovery_marker_exists"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn updater_errors_map_to_safe_diagnostic_codes() {
        let unrestored = Error::PreviousAppNotRestored("/private/backup".into());
        assert!(requires_manual_recovery(&unrestored));
        assert_eq!(update_failure_code(&unrestored), "rollback-failed");
        assert!(!requires_manual_recovery(&Error::InvalidUpdaterFormat));
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
