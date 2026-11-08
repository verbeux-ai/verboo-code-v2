//! Check the update feed once per launch and install a confirmed update.
//!
//! The Host owns the product window, so the update is offered natively and
//! installed by the Tauri updater. Every failure stays silent: an unreachable
//! feed, a malformed manifest or a refused install must never block startup.

use crate::locale;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

/// Version the operator declined, stored so the same update asks once.
const DECLINED_FILE: &str = "update-declined";

fn declined_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join(DECLINED_FILE))
}

fn declined_version(app: &tauri::AppHandle) -> Option<String> {
    let path = declined_file(app)?;
    std::fs::read_to_string(path)
        .ok()
        .map(|version| version.trim().to_string())
}

fn remember_declined(app: &tauri::AppHandle, version: &str) {
    let Some(path) = declined_file(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if std::fs::write(path, version).is_err() {
        eprintln!("Verboo Code: update_declined_not_recorded");
    }
}

/// Ask before downloading, then install and restart on confirmation.
async fn install(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    if declined_version(&app).as_deref() == Some(update.version.as_str()) {
        return Ok(());
    }
    let confirmed = app
        .dialog()
        .message(locale::update_available(&update.version))
        .title("Verboo Code")
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            locale::update_install().to_string(),
            locale::update_later().to_string(),
        ))
        .blocking_show();
    if !confirmed {
        remember_declined(&app, &update.version);
        return Ok(());
    }
    update
        .download_and_install(
            |_chunk_length, _content_length| {},
            || eprintln!("Verboo Code: update_downloaded"),
        )
        .await?;
    eprintln!("Verboo Code: update_installed");
    app.restart();
}

/// Offer an available update without holding up the window.
pub fn spawn(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = tauri::async_runtime::block_on(install(app)) {
            eprintln!("Verboo Code: update_check_failed {error}");
        }
    });
}
