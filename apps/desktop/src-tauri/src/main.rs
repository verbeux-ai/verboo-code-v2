#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;
mod locale;
mod layout_storage;
mod menu;
mod update;
mod update_logic;

use host::{authenticated_url, HostEvent, HostProcess, QuitReservation, RuntimeConfig, STARTUP_DEADLINE};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
};
use tauri::{
    ipc::CapabilityBuilder, webview::NewWindowResponse, Manager, RunEvent, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

mod navigation;

use navigation::{navigation_decision, NavigationDecision};

#[derive(Default)]
struct HostState {
    process: Mutex<Option<HostProcess>>,
    origin: OnceLock<url::Origin>,
    bootstrap: Mutex<Option<url::Url>>,
    quitting: AtomicBool,
    client_ready: AtomicBool,
    quit_confirmation: AtomicBool,
    exit_ready: AtomicBool,
    quit_response: Mutex<Option<mpsc::Sender<bool>>>,
    host_disconnected: AtomicBool,
    failure_reported: AtomicBool,
    startup_retry_allowed: AtomicBool,
    // 0 = finished, 1 = installation/setup protected, 2 = waiting for another instance, 3 = cancelled.
    startup_install_phase: AtomicU8,
}

fn claim_install_start(phase: &AtomicU8) -> bool {
    phase.load(Ordering::SeqCst) == 1 || phase.compare_exchange(2, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok()
}

fn cancel_install_wait(phase: &AtomicU8) -> bool {
    phase.compare_exchange(2, 3, Ordering::SeqCst, Ordering::SeqCst).is_ok()
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

    fn reserve_idle(&self) -> Result<QuitReservation, String> {
        let mut process = self.process.lock().map_err(|_| "host_state_poisoned")?;
        match process.as_mut() {
            Some(process) => process.reserve_idle().map_err(str::to_string),
            None => Ok(QuitReservation::Confirm),
        }
    }

    fn finalize_idle(&self, lease: u64) -> Result<bool, String> {
        let mut process = self.process.lock().map_err(|_| "host_state_poisoned")?;
        process.as_mut().ok_or("quit_host_unavailable")?.finalize_idle(lease).map_err(str::to_string)
    }

    fn cancel_idle(&self, lease: u64) -> Result<(), String> {
        let mut process = self.process.lock().map_err(|_| "host_state_poisoned")?;
        process.as_mut().ok_or("quit_host_unavailable")?.cancel_idle(lease).map_err(str::to_string)
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
fn quit_after_hold(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<HostState>>,
) -> Result<(), String> {
    owned_window(&window, &state)?;
    eprintln!("Verboo Code: quit_hold_confirmed");
    window.app_handle().exit(0);
    Ok(())
}

#[tauri::command]
fn quit_confirmation_response(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<HostState>>,
    confirmed: bool,
) -> Result<(), String> {
    owned_window(&window, &state)?;
    let sender = state.quit_response.lock().map_err(|_| "quit_state_unavailable")?.take()
        .ok_or("quit_confirmation_not_pending")?;
    sender.send(confirmed).map_err(|_| "quit_confirmation_expired".into())
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
fn desktop_layout_read(window: WebviewWindow, state: tauri::State<'_, Arc<HostState>>) -> Result<std::collections::BTreeMap<String, String>, String> {
    owned_window(&window, &state)?;
    let root = window.app_handle().path().app_data_dir().map_err(|_| "layout_storage_unavailable")?;
    layout_storage::read(&root).map_err(str::to_owned)
}

#[tauri::command]
fn desktop_layout_write(window: WebviewWindow, state: tauri::State<'_, Arc<HostState>>, key: String, value: Option<String>) -> Result<(), String> {
    owned_window(&window, &state)?;
    let root = window.app_handle().path().app_data_dir().map_err(|_| "layout_storage_unavailable")?;
    layout_storage::write(&root, &key, value).map_err(str::to_owned)
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
    if state.failure_reported.swap(true, Ordering::SeqCst) { return; }
    eprintln!("Verboo Code: {code}");
    state.quitting.store(true, Ordering::SeqCst);
    if let Ok(mut pending) = state.quit_response.lock() {
        if let Some(sender) = pending.take() { let _ = sender.send(false); }
    }
    let app = app.clone();
    let state = Arc::clone(&app.state::<Arc<HostState>>());
    let code = code.to_owned();
    thread::spawn(move || {
        let stopped = match state.stop() {
            Ok(()) => true,
            Err(code) => { eprintln!("Verboo Code: {code}"); false }
        };
        state.startup_retry_allowed.store(stopped, Ordering::SeqCst);
        state.exit_ready.store(true, Ordering::SeqCst);
        let capability = CapabilityBuilder::new("startup-recovery")
            .local(true).window("startup-error").permission("startup-recovery");
        let safe_code = match code.as_str() {
            "runtime_artifact_missing" | "host_home_unavailable" | "host_startup_failed"
            | "host_disconnected" | "desktop_authentication_failed" | "desktop_navigation_failed"
            | "update_lock_unavailable" | "update_recovery_unavailable" => code.as_str(),
            _ => "startup_failed",
        };
        let config = serde_json::json!({ "code": safe_code, "canRetry": stopped });
        let script = format!("window.__VERBOO_STARTUP_ERROR__ = {config};");
        let recovery = app.add_capability(capability).and_then(|_| {
            WebviewWindowBuilder::new(&app, "startup-error", WebviewUrl::App("startup-error.html".into()))
                .title("Verboo Code")
                .inner_size(720.0, 600.0)
                .min_inner_size(480.0, 500.0)
                .initialization_script(&script)
                .on_navigation(|url| {
                    let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
                    local && url.path() == "/startup-error.html" && url.query().is_none() && url.fragment().is_none()
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()
        });
        if recovery.is_ok() {
            if let Some(main) = app.get_webview_window("main") { let _ = main.hide(); }
        } else {
            app.dialog().message(locale::startup_failure()).title("Verboo Code").blocking_show();
            app.exit(1);
        }
    });
}

/// Restart only the local recovery window after the Host was safely stopped.
#[tauri::command]
fn startup_retry(app: tauri::AppHandle, window: WebviewWindow, state: tauri::State<'_, Arc<HostState>>) -> Result<(), String> {
    if window.label() != "startup-error" || !state.failure_reported.load(Ordering::SeqCst)
        || !state.startup_retry_allowed.load(Ordering::SeqCst) {
        return Err("startup_retry_denied".into());
    }
    app.request_restart();
    Ok(())
}

/// A failed admission exchange never authorizes shutdown or claims the Host is available.
fn quit_check_failure(app: &tauri::AppHandle, code: &str) {
    eprintln!("Verboo Code: {code}");
    let dialog = app.dialog().message(locale::quit_check_failure()).title("Verboo Code");
    let dialog = match app.get_webview_window("main") {
        Some(window) => dialog.parent(&window),
        None => dialog,
    };
    dialog.blocking_show();
}

/// Hand one destination to the system browser, reporting a failed handoff.
///
/// A refused handoff leaves the click with no visible effect, so it is logged
/// for the same native diagnostics the client reports through.
fn open_externally(app: &tauri::AppHandle, url: &url::Url) {
    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
        eprintln!("Verboo Code: external_link_failed");
    }
}

fn main() {
    let state = Arc::new(HostState::default());
    let setup_state = state.clone();
    let window_state = state.clone();
    let app = tauri::Builder::default()
        .menu(menu::build)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == menu::QUIT {
                app.exit(0);
                return;
            }
            if event.id().as_ref() == menu::CLOSE_PANE {
                if let Some(window) = app.get_webview_window("main") {
                    if window
                        .eval("window.dispatchEvent(new Event('verboo-close-pane'))")
                        .is_err()
                    {
                        eprintln!("Verboo Code: close_pane_failed");
                    }
                }
            }
        })
        .on_window_event(move |window, event| {
            if window.label() == "startup-error" {
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) { window.app_handle().exit(1); }
                return;
            }
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window_state.exit_ready.load(Ordering::SeqCst) {
                    api.prevent_close();
                    window.app_handle().exit(0);
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            pick_directory,
            desktop_info,
            client_ready,
            desktop_layout_read,
            desktop_layout_write,
            client_diagnostic,
            update::update_install,
            update::update_close,
            update::update_snapshot,
            update::update_restart,
            update::update_retry,
            startup_retry,
            quit_after_hold,
            quit_confirmation_response
        ])
        .setup(move |app| {
            update::install(&app.handle());
            setup_state.startup_install_phase.store(1, Ordering::SeqCst);
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Verboo Code")
                    .inner_size(1320.0, 860.0)
                    .min_inner_size(900.0, 600.0)
                    // The document canvas before the page paints: a native
                    // window defaults to white, so a repaint that lands ahead
                    // of the boot style (a reopened window, a resumed view)
                    // flashed white behind the dark document. This matches the
                    // dark boot colour in the theme sheet.
                    .background_color(tauri::window::Color(21, 21, 23, 255))
                    // Keep the view live while it is hidden: the default policy
                    // unloads a backgrounded view, and bringing it forward then
                    // repaints from scratch. Unsupported on Linux, where the
                    // boot style alone owns the first frame.
                    .background_throttling(
                        tauri::utils::config::BackgroundThrottlingPolicy::Disabled,
                    )
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
                            // A navigation invalidates any renderer-owned confirmation. Cancel it
                            // rather than leaving the native exit worker waiting on a lost dialog.
                            if let Ok(mut pending) = state.quit_response.lock() {
                                if let Some(sender) = pending.take() { let _ = sender.send(false); }
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
                        move |url| match navigation_decision(url, state.origin.get()) {
                            NavigationDecision::NavigateHere => true,
                            NavigationDecision::OpenExternally => {
                                open_externally(&app, url);
                                false
                            }
                            NavigationDecision::Deny => false,
                        }
                    })
                    .on_new_window({
                        let state = setup_state.clone();
                        let app = app.handle().clone();
                        move |url, _features| {
                            // The product is one window. A destination that asks
                            // for its own window either leaves the application or
                            // is dropped; a second Webview is never created.
                            match navigation_decision(&url, state.origin.get()) {
                                NavigationDecision::OpenExternally => open_externally(&app, &url),
                                NavigationDecision::NavigateHere | NavigationDecision::Deny => {
                                    eprintln!("Verboo Code: new_window_denied");
                                }
                            }
                            NewWindowResponse::Deny
                        }
                    })
                    .build()?;
            let app = app.handle().clone();
            let setup_state = setup_state.clone();
            thread::spawn(move || {
                let wait_window = window.clone();
                let wait_state = setup_state.clone();
                let proceed_state = setup_state.clone();
                let result = update::install_pending(&app, move || {
                    wait_state.startup_install_phase.store(2, Ordering::SeqCst);
                    let text = serde_json::to_string(locale::update_install_wait()).expect("localized text serializes");
                    let _ = wait_window.eval(format!("(()=>{{window.__verbooInstallWait=true;const show=()=>{{if(!window.__verbooInstallWait)return;let p=document.getElementById('install-wait');if(!p){{p=document.createElement('p');p.id='install-wait';p.style.cssText='color:#c9c2cf;text-align:center;font:14px system-ui;margin-top:28px';document.querySelector('main')?.appendChild(p)}}if(p)p.textContent={text}}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show,{{once:true}});else show()}})()"));
                }, move || {
                    claim_install_start(&proceed_state.startup_install_phase)
                });
                let _ = window.eval("window.__verbooInstallWait=false;document.getElementById('install-wait')?.remove()");
                setup_state.startup_install_phase.store(0, Ordering::SeqCst);
                match result {
                    Ok(true) => return,
                    Err(code) => { startup_failure(&app, &setup_state, code); return; }
                    Ok(false) => (),
                }
                if setup_state.quitting.load(Ordering::SeqCst) { return; }
                update::show_applied(&app);
                let startup = || -> Result<(), String> {
            let config_file = match std::env::var_os("VERBOO_TAURI_RUNTIME_CONFIG") {
                Some(path) => PathBuf::from(path),
                None => app.path().resource_dir().map_err(|_| "runtime_config_unreadable")?.join("runtime/manifest.json"),
            };
            let config = RuntimeConfig::read(&config_file)?;
            let home = match std::env::var_os("DSH_HOME").map(PathBuf::from).or(config.home.clone()) {
                Some(home) => home,
                None => app.path().app_data_dir().map_err(|_| "host_home_unavailable")?.join("home"),
            };
            let (process, events) =
                HostProcess::start(&config, &home, &app.package_info().version.to_string())?;
            *setup_state
                .process
                .lock()
                .map_err(|_| "host_state_poisoned")? = Some(process);
            let app = app.clone();
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
                    url::Url::parse(&format!("{}/desktop-startup.html", url.origin().ascii_serialization()))
                        .expect("validated Host origin");
                *state.bootstrap.lock().expect("Host bootstrap lock") = Some(url);
                if app.add_capability(capability).is_err() || window.navigate(origin_url).is_err() {
                    startup_failure(&app, &state, "desktop_navigation_failed");
                    return;
                }
                eprintln!("Verboo Code: tauri_host_ready");
                update::spawn(&app);
                while events.recv().is_ok() {}
                state.host_disconnected.store(true, Ordering::SeqCst);
                if !state.quitting.load(Ordering::SeqCst) {
                    startup_failure(&app, &state, "host_disconnected");
                }
            });
                    Ok(())
                };
                if let Err(code) = startup() {
                    if !setup_state.quitting.load(Ordering::SeqCst) {
                        startup_failure(&app, &setup_state, &code);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Verboo Code: native application initialization failed");
    app.run(move |app, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if !state.exit_ready.load(Ordering::SeqCst) {
                api.prevent_exit();
                if code != Some(tauri::RESTART_EXIT_CODE) {
                    let phase = &state.startup_install_phase;
                    if cancel_install_wait(phase) {
                        state.exit_ready.store(true, Ordering::SeqCst);
                        app.exit(0);
                        return;
                    }
                    if phase.load(Ordering::SeqCst) != 0 { return; }
                }
                if state.quitting.load(Ordering::SeqCst) {
                    return;
                }
                if state.quit_confirmation.swap(true, Ordering::SeqCst) {
                    return;
                }
                let app = app.clone();
                let state = state.clone();
                thread::spawn(move || {
                    let mut finalized_idle = false;
                    if code != Some(tauri::RESTART_EXIT_CODE) {
                        match state.reserve_idle() {
                            Ok(QuitReservation::Reserved(lease)) => {
                                if state.quitting.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                                    let _ = state.cancel_idle(lease);
                                    state.quit_confirmation.store(false, Ordering::SeqCst);
                                    return;
                                }
                                match state.finalize_idle(lease) {
                                    Ok(true) => finalized_idle = true,
                                    Ok(false) => state.quitting.store(false, Ordering::SeqCst),
                                    Err(error) => {
                                        // Finalization may already have started; do not force a Host shutdown.
                                        let own_report = !state.failure_reported.swap(true, Ordering::SeqCst);
                                        state.quitting.store(false, Ordering::SeqCst);
                                        state.quit_confirmation.store(false, Ordering::SeqCst);
                                        if own_report { quit_check_failure(&app, &error); }
                                        if state.host_disconnected.load(Ordering::SeqCst) {
                                            state.exit_ready.store(true, Ordering::SeqCst);
                                            app.exit(1);
                                        } else if own_report {
                                            state.failure_reported.store(false, Ordering::SeqCst);
                                            // A disconnection between the read and resetting the report is still reported.
                                            if state.host_disconnected.load(Ordering::SeqCst) {
                                                startup_failure(&app, &state, "host_disconnected");
                                            }
                                        }
                                        return;
                                    }
                                }
                            }
                            Ok(QuitReservation::Confirm) => (),
                            Err(error) => {
                                state.quit_confirmation.store(false, Ordering::SeqCst);
                                quit_check_failure(&app, &error);
                                return;
                            }
                        }
                    }
                    if code != Some(tauri::RESTART_EXIT_CODE) && !finalized_idle {
                        eprintln!("Verboo Code: quit_confirmation_requested");
                        let confirmed = if state.client_ready.load(Ordering::SeqCst) {
                            if let Some(window) = app.get_webview_window("main") {
                                let (sender, receiver) = mpsc::channel();
                                if let Ok(mut pending) = state.quit_response.lock() {
                                    *pending = Some(sender);
                                } else {
                                    state.quit_confirmation.store(false, Ordering::SeqCst);
                                    return;
                                }
                                if window.eval("window.dispatchEvent(new Event('verboo-quit-confirmation'))").is_err() {
                                    if let Ok(mut pending) = state.quit_response.lock() { pending.take(); }
                                    false
                                } else {
                                    receiver.recv().unwrap_or(false)
                                }
                            } else { false }
                        } else {
                            // Before the product UI is ready, retain a safe native fallback.
                            app.dialog().message(locale::quit_message()).title(locale::quit_title())
                                .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                                    locale::quit_confirm().to_string(), locale::quit_cancel().to_string(),
                                )).blocking_show()
                        };
                        if !confirmed {
                            eprintln!("Verboo Code: quit_cancelled");
                            state.quit_confirmation.store(false, Ordering::SeqCst);
                            return;
                        }
                    }
                    eprintln!("Verboo Code: quit_confirmed");
                    if !finalized_idle && state.quitting.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                        state.quit_confirmation.store(false, Ordering::SeqCst);
                        return;
                    }
                    let code = match state.stop() {
                        Ok(()) => {
                            eprintln!("Verboo Code: host_shutdown_complete");
                            code.unwrap_or(0)
                        }
                        Err(code) => {
                            eprintln!("Verboo Code: {code}");
                            1
                        }
                    };
                    state.exit_ready.store(true, Ordering::SeqCst);
                    app.exit(code);
                });
            }
        }
    });
}

#[cfg(test)]
mod startup_install_tests {
    use super::{cancel_install_wait, claim_install_start};
    use std::sync::{atomic::{AtomicU8, Ordering}, Arc, Barrier};
    use std::thread;

    #[test]
    fn installation_and_wait_cancellation_are_mutually_exclusive() {
        for _ in 0..100 {
            let phase = Arc::new(AtomicU8::new(2));
            let barrier = Arc::new(Barrier::new(2));
            let worker_phase = phase.clone();
            let worker_barrier = barrier.clone();
            let worker = thread::spawn(move || {
                worker_barrier.wait();
                claim_install_start(&worker_phase)
            });
            barrier.wait();
            let cancelled = cancel_install_wait(&phase);
            let installing = worker.join().unwrap();
            assert_ne!(cancelled, installing);
            assert_eq!(phase.load(Ordering::SeqCst), if cancelled { 3 } else { 1 });
        }
    }
}
