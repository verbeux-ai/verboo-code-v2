#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;
mod locale;
mod native_messaging;
mod update;

use host::{authenticated_url, HostEvent, HostProcess, RuntimeConfig, STARTUP_DEADLINE};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
};
use tauri::{
    ipc::CapabilityBuilder, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct HostState {
    process: Mutex<Option<HostProcess>>,
    origin: OnceLock<url::Origin>,
    bootstrap: Mutex<Option<url::Url>>,
    quitting: AtomicBool,
    client_ready: AtomicBool,
}

impl HostState {
    fn stop(&self) -> Result<(), String> {
        let process = self
            .process
            .lock()
            .map_err(|_| "host_state_poisoned")?
            .take();
        match process {
            Some(mut process) => process.stop(),
            None => Ok(()),
        }
    }
}

fn owned_window(window: &WebviewWindow, state: &HostState) -> Result<(), String> {
    let origin = window.url().map_err(|_| "window_url_unavailable")?.origin();
    if window.label() != "main" || state.origin.get() != Some(&origin) {
        return Err("desktop_access_denied".into());
    }
    Ok(())
}

#[tauri::command]
async fn pick_directory(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<HostState>>,
) -> Result<Option<String>, String> {
    owned_window(&window, &state)?;
    let app = window.app_handle().clone();
    let parent = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&parent)
            .blocking_pick_folder()
            .map(|path| {
                path.into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|_| "directory_path_invalid".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "directory_picker_failed".to_string())?
}

#[tauri::command]
fn desktop_info(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<HostState>>,
) -> Result<String, String> {
    owned_window(&window, &state)?;
    eprintln!("Verboo Code: native_bridge_ready");
    Ok(format!(
        "Verboo Code / Tauri 2 / {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    ))
}

#[tauri::command]
fn client_ready(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<HostState>>,
) -> Result<(), String> {
    owned_window(&window, &state)?;
    if !state.client_ready.swap(true, Ordering::SeqCst) {
        eprintln!("Verboo Code: native_client_ready");
    }
    Ok(())
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ClientFrame {
    asset: String,
    line: u32,
    column: u32,
}

#[tauri::command]
fn client_diagnostic(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<HostState>>,
    frames: Vec<ClientFrame>,
    entries: Vec<String>,
) -> Result<(), String> {
    owned_window(&window, &state)?;
    if frames.len() > 5
        || frames.iter().any(|frame| {
            frame.asset.len() > 160
                || !frame
                    .asset
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"/._-".contains(&byte))
        })
    {
        return Err("client_diagnostic_invalid".into());
    }
    if entries.len() > 32
        || entries.iter().any(|entry| {
            entry.len() > 120
                || !entry
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"/@._-".contains(&byte))
        })
    {
        return Err("client_diagnostic_invalid".into());
    }
    eprintln!(
        "Verboo Code: client_script_error {}",
        serde_json::json!({ "frames": frames, "entries": entries })
    );
    Ok(())
}

fn startup_failure(app: &tauri::AppHandle, state: &HostState, code: &str) {
    eprintln!("Verboo Code: {code}");
    state.quitting.store(true, Ordering::SeqCst);
    if let Err(code) = state.stop() {
        eprintln!("Verboo Code: {code}");
    }
    app.dialog()
        .message(locale::startup_failure())
        .title("Verboo Code")
        .blocking_show();
    app.exit(1);
}

fn main() {
    let state = Arc::new(HostState::default());
    let setup_state = state.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            pick_directory,
            desktop_info,
            client_ready,
            client_diagnostic
        ])
        .setup(move |app| {
            if let Err(code) = native_messaging::register(&app.handle()) {
                eprintln!("Verboo Code: {code}");
            }
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Verboo Code")
                    .inner_size(1320.0, 860.0)
                    .min_inner_size(900.0, 600.0)
                    .initialization_script(include_str!("../../tauri/bridge.js"))
                    .disable_drag_drop_handler()
                    .on_page_load({
                        let state = setup_state.clone();
                        move |window, payload| {
                            if payload.event() != tauri::webview::PageLoadEvent::Finished
                                || state.origin.get() != Some(&payload.url().origin())
                            {
                                return;
                            }
                            let bootstrap =
                                state.bootstrap.lock().ok().and_then(|mut url| url.take());
                            if let Some(url) = bootstrap {
                                // Strict cookies on a redirect from tauri:// are cross-site in WebKit.
                                // Start the exchange from a document already on the owned Host origin.
                                let target = serde_json::to_string(url.as_str())
                                    .expect("URL is serializable");
                                if window
                                    .eval(format!("window.location.replace({target})"))
                                    .is_err()
                                {
                                    startup_failure(
                                        window.app_handle(),
                                        &state,
                                        "desktop_authentication_failed",
                                    );
                                }
                                return;
                            }
                            eprintln!("Verboo Code: native_page_loaded");
                            let _title = window.set_title("Verboo Code");
                        }
                    })
                    .on_navigation({
                        let state = setup_state.clone();
                        let app = app.handle().clone();
                        move |url| {
                            if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
                            {
                                return true;
                            }
                            if state
                                .origin
                                .get()
                                .is_some_and(|origin| origin == &url.origin())
                            {
                                return true;
                            }
                            if matches!(url.scheme(), "http" | "https" | "mailto") {
                                if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
                                    eprintln!("Verboo Code: external_link_failed");
                                }
                            }
                            false
                        }
                    })
                    .build()?;
            let config_file = std::env::var_os("VERBOO_TAURI_RUNTIME_CONFIG")
                .map(PathBuf::from)
                .unwrap_or(app.path().resource_dir()?.join("runtime/manifest.json"));
            let config = RuntimeConfig::read(&config_file).map_err(std::io::Error::other)?;
            let home = std::env::var_os("DSH_HOME")
                .map(PathBuf::from)
                .or(config.home.clone())
                .unwrap_or(app.path().app_data_dir()?.join("home"));
            let (process, events) =
                HostProcess::start(&config, &home).map_err(std::io::Error::other)?;
            *setup_state
                .process
                .lock()
                .map_err(|_| std::io::Error::other("host_state_poisoned"))? = Some(process);
            let app = app.handle().clone();
            let state = setup_state.clone();
            thread::spawn(move || {
                let ready = match events.recv_timeout(STARTUP_DEADLINE) {
                    Ok(HostEvent::Ready { url }) => authenticated_url(&url),
                    Ok(HostEvent::Fatal { code }) => Err(code),
                    _ => Err("host_startup_failed".into()),
                };
                let url = match ready {
                    Ok(url) => url,
                    Err(code) => {
                        if !state.quitting.load(Ordering::SeqCst) {
                            startup_failure(&app, &state, &code);
                        }
                        return;
                    }
                };
                if state.quitting.load(Ordering::SeqCst) {
                    return;
                }
                if state.origin.set(url.origin()).is_err() {
                    startup_failure(&app, &state, "host_origin_already_set");
                    return;
                }
                let capability = CapabilityBuilder::new("desktop-host")
                    .local(false)
                    .window("main")
                    .remote(format!("{}/*", url.origin().ascii_serialization()))
                    .permission("desktop-native")
                    .permission("opener:allow-open-url")
                    .permission("opener:allow-default-urls");
                let origin_url =
                    url::Url::parse(&format!("{}/", url.origin().ascii_serialization()))
                        .expect("validated Host origin");
                *state.bootstrap.lock().expect("Host bootstrap lock") = Some(url);
                if app.add_capability(capability).is_err() || window.navigate(origin_url).is_err() {
                    startup_failure(&app, &state, "desktop_navigation_failed");
                    return;
                }
                eprintln!("Verboo Code: tauri_host_ready");
                update::spawn(&app);
                while events.recv().is_ok() {}
                if !state.quitting.load(Ordering::SeqCst) {
                    startup_failure(&app, &state, "host_disconnected");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Verboo Code: native application initialization failed");
    app.run(move |app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !state.quitting.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let app = app.clone();
                let state = state.clone();
                thread::spawn(move || {
                    let code = match state.stop() {
                        Ok(()) => {
                            eprintln!("Verboo Code: host_shutdown_complete");
                            0
                        }
                        Err(code) => {
                            eprintln!("Verboo Code: {code}");
                            1
                        }
                    };
                    app.exit(code);
                });
            }
        }
    });
}
