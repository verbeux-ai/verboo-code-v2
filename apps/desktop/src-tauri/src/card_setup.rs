use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use url::Url;

const FORM_PATH: &str = "/api/desktop/card-setup";
const CLOSE_PATH: &str = "/api/desktop/card-setup/close";
const COMPLETE_PATH: &str = "/api/desktop/card-setup/complete";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CardSetup {
    operation: String,
    url: String,
    client_secret: String,
    publishable_key: String,
    locale: String,
    theme: String,
    labels: Labels,
}

#[derive(Deserialize, Serialize)]
struct Labels {
    title: String,
    description: String,
    close: String,
    loading: String,
    failed: String,
}

fn window_label(operation: &str) -> Result<String, String> {
    if operation.len() != 36
        || !operation
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
    {
        return Err("card_setup_invalid".into());
    }
    Ok(format!("card-setup-{operation}"))
}

fn form_url(setup: &CardSetup) -> Result<Url, String> {
    let url = Url::parse(&setup.url).map_err(|_| "card_setup_invalid")?;
    let default_origin = url.origin().ascii_serialization() == "https://code.verboo.ai";
    let sandbox = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && std::env::var("VERBOO_API_ORIGIN").ok().as_deref()
            == Some(url.origin().ascii_serialization().as_str())
        && setup.publishable_key.starts_with("pk_test_")
        && setup.client_secret.starts_with("cs_test_");
    if (!default_origin && !sandbox)
        || url.path() != FORM_PATH
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("card_setup_invalid".into());
    }
    let correct_mode = (setup.publishable_key.starts_with("pk_test_")
        && setup.client_secret.starts_with("cs_test_"))
        || (setup.publishable_key.starts_with("pk_live_")
            && setup.client_secret.starts_with("cs_live_"));
    if !correct_mode || !setup.client_secret.contains("_secret_") {
        return Err("card_setup_invalid".into());
    }
    Ok(url)
}

/// Open a child payment dialog with independent storage and no product bridge.
/// Completion tells the parent to read its account API, where the webhook owns the result.
#[tauri::command]
pub(crate) async fn open_card_setup(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<crate::HostState>>,
    setup: CardSetup,
) -> Result<bool, String> {
    crate::owned_window(&window, &state)?;
    let label = window_label(&setup.operation)?;
    let url = form_url(&setup)?;
    let (send, mut outcome) = tauri::async_runtime::channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = build_dialog(&handle, &window, &label, url, setup, send.clone()) {
            let _ = send.try_send(Err(error));
        }
    })
    .map_err(|_| "card_setup_unavailable")?;
    outcome
        .recv()
        .await
        .unwrap_or_else(|| Err("card_setup_unavailable".into()))
}

fn build_dialog(
    app: &AppHandle,
    parent: &WebviewWindow,
    label: &str,
    url: Url,
    setup: CardSetup,
    send: tauri::async_runtime::Sender<Result<bool, String>>,
) -> Result<(), String> {
    if app
        .webview_windows()
        .keys()
        .any(|name| name.starts_with("card-setup-"))
    {
        return Err("card_setup_already_open".into());
    }
    let data = serde_json::to_string(&setup).map_err(|_| "card_setup_invalid")?;
    let form = serde_json::to_string(url.as_str()).map_err(|_| "card_setup_invalid")?;
    let init = format!("if (location.href === {form}) window.startVerbooCardSetup?.({data});");
    let checkout = url.clone();
    let form_url = url.clone();
    let trusted_origin = url.origin();
    let destination_origin = trusted_origin.clone();
    let completed = Arc::new(AtomicBool::new(false));
    let signal = completed.clone();
    let navigation_app = app.clone();
    let navigation_label = label.to_owned();

    let blank = Url::parse("about:blank").expect("valid blank document URL");
    let dialog = WebviewWindowBuilder::new(app, label, WebviewUrl::External(blank))
        .parent(parent)
        .map_err(|_| "card_setup_unavailable")?
        .title(&setup.labels.title)
        .inner_size(590.0, 690.0)
        .min_inner_size(390.0, 460.0)
        .center()
        .skip_taskbar(true)
        .incognito(true)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_navigation(move |target| {
            if target.origin() == destination_origin
                && matches!(target.path(), CLOSE_PATH | COMPLETE_PATH)
            {
                signal.store(target.path() == COMPLETE_PATH, Ordering::SeqCst);
                let handle = navigation_app.clone();
                let name = navigation_label.clone();
                let _ = navigation_app.run_on_main_thread(move || {
                    if let Some(dialog) = handle.get_webview_window(&name) {
                        let _ = dialog.close();
                    }
                });
                return false;
            }
            // Issuer frames can use their own HTTPS hosts for 3-D Secure.
            target == &checkout
                || matches!(target.as_str(), "about:blank" | "about:srcdoc")
                || (target.scheme() == "https"
                    && target.username().is_empty()
                    && target.password().is_none())
        })
        .on_page_load(move |window, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            if payload.url().origin() == trusted_origin && payload.url().path() == FORM_PATH {
                let _ = window.eval(&init);
            } else if matches!(payload.url().scheme(), "http" | "https") {
                // Disallow replacing the top-level payment document with a provider or issuer page.
                let _ = window.close();
            }
        })
        .build()
        .map_err(|_| "card_setup_unavailable")?;

    #[cfg(target_os = "linux")]
    {
        // The ephemeral payment context needs a BCP 47 locale for Stripe's 3DS WebView.
        use webkit2gtk::{WebContextExt, WebViewExt};
        let language = if setup.locale == "pt" {
            "pt-BR".into()
        } else {
            setup.locale
        };
        if dialog
            .with_webview(move |view| {
                if let Some(context) = view.inner().context() {
                    context.set_preferred_languages(&[&language]);
                }
            })
            .is_err()
        {
            let _ = dialog.close();
            return Err("card_setup_unavailable".into());
        }
    }
    if dialog.navigate(form_url).is_err() {
        let _ = dialog.close();
        return Err("card_setup_unavailable".into());
    }

    let _ = parent.set_enabled(false);
    let parent = parent.clone();
    dialog.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let _ = parent.set_enabled(true);
            let _ = parent.set_focus();
            let _ = send.try_send(Ok(completed.load(Ordering::SeqCst)));
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn close_card_setup(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<crate::HostState>>,
    operation: String,
) -> Result<(), String> {
    crate::owned_window(&window, &state)?;
    if let Some(dialog) = app.get_webview_window(&window_label(&operation)?) {
        dialog.close().map_err(|_| "card_setup_unavailable")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payment_bootstrap_requires_the_exact_deployment_path_and_matching_stripe_modes() {
        let mut setup = CardSetup {
            operation: "00000000-0000-4000-8000-000000000001".into(),
            url: "https://code.verboo.ai/api/desktop/card-setup".into(),
            client_secret: "cs_test_fixture_secret_fixture".into(),
            publishable_key: "pk_test_fixture".into(),
            locale: "pt".into(),
            theme: "dark".into(),
            labels: Labels {
                title: "Trocar cartão".into(),
                description: String::new(),
                close: String::new(),
                loading: String::new(),
                failed: String::new(),
            },
        };
        assert!(form_url(&setup).is_ok());
        assert!(window_label(&setup.operation).is_ok());
        assert!(window_label("main").is_err());
        for invalid in [
            "https://code.verboo.ai.example.test/api/desktop/card-setup",
            "https://code.verboo.ai@other.example.test/api/desktop/card-setup",
            "https://code.verboo.ai/api/desktop/card-setup?next=remote",
            "https://code.verboo.ai/api/desktop/other",
        ] {
            setup.url = invalid.into();
            assert!(form_url(&setup).is_err());
        }
        setup.url = "https://code.verboo.ai/api/desktop/card-setup".into();
        setup.publishable_key = "pk_live_fixture".into();
        assert!(form_url(&setup).is_err());
    }
}
