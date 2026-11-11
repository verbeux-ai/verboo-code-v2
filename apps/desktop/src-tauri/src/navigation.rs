/**
 * What this Webview does with one navigation request.
 *
 * The policy names no Tauri symbol: the in-place navigation hook, the
 * new-window hook, and the unit tests below all reach this one decision, and a
 * host without a WebView toolkit can still execute it.
 */
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum NavigationDecision {
    /// Keep the request inside this Webview: the application protocol, or the owned Host origin.
    NavigateHere,
    /// Hand the destination to the operating system and leave this Webview on its current document.
    OpenExternally,
    /// Neither navigate nor hand off; the request is dropped.
    Deny,
}

/// Decide one navigation request without touching the application or the system.
///
/// The application protocol and the owned Host origin belong to this Webview.
/// A destination this program hands to another program is reported as such, so
/// the in-place navigation hook and the new-window hook reach one decision.
/// Every other scheme is denied rather than loaded in place.
pub(crate) fn navigation_decision(url: &url::Url, owned_origin: Option<&url::Origin>) -> NavigationDecision {
    // The window owns exactly two documents: the application protocol and the
    // Host page. Both are pages this program packaged or served, so a scheme
    // outside that set is refused before any origin comparison runs: `blob:`
    // and `data:` inherit the creating document's origin, and a top-level
    // navigation to one would replace the application with foreign bytes.
    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
        return NavigationDecision::NavigateHere;
    }
    if !matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        return NavigationDecision::Deny;
    }
    // Embedded credentials must never reach the system opener.
    if !url.username().is_empty() || url.password().is_some() {
        return NavigationDecision::Deny;
    }
    // Same origin after the scheme filter is the owned Host page itself. The
    // Host reports its origin only once ready, so before that every page is
    // handed off instead of loaded in place.
    if owned_origin.is_some_and(|origin| origin == &url.origin()) {
        return NavigationDecision::NavigateHere;
    }
    NavigationDecision::OpenExternally
}


#[cfg(test)]
mod tests {
    use super::*;

    fn owned() -> url::Origin {
        url::Url::parse("http://127.0.0.1:31501/")
            .unwrap()
            .origin()
    }

    fn decide(address: &str, origin: Option<&url::Origin>) -> NavigationDecision {
        navigation_decision(&url::Url::parse(address).unwrap(), origin)
    }

    #[test]
    fn keeps_the_native_protocol_and_the_owned_origin_in_this_webview() {
        let origin = owned();
        for address in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "http://127.0.0.1:31501/session/1",
        ] {
            assert_eq!(
                decide(address, Some(&origin)),
                NavigationDecision::NavigateHere,
                "{address}"
            );
        }
    }

    #[test]
    fn hands_only_allowlisted_schemes_to_the_operating_system() {
        let origin = owned();
        for address in [
            "https://code.verboo.ai/docs",
            "http://127.0.0.1:8080/health",
            "mailto:dev@example.com",
            "tel:+5511999999999",
        ] {
            assert_eq!(
                decide(address, Some(&origin)),
                NavigationDecision::OpenExternally,
                "{address}"
            );
        }
    }

    #[test]
    fn denies_embedded_documents_scripts_and_other_programs() {
        let origin = owned();
        for address in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "blob:http://127.0.0.1:31501/id",
            "verboo://open",
            "ssh://git@example.com/repo",
            "ftp://example.com/file",
            "https://user:secret@code.verboo.ai/",
        ] {
            assert_eq!(decide(address, Some(&origin)), NavigationDecision::Deny, "{address}");
        }
    }

    #[test]
    fn refuses_origin_look_alikes_that_carry_the_host_address() {
        let origin = owned();
        // A host string that merely contains the Host address is a different
        // origin, so the window hands it out instead of loading it as its own
        // document.
        for address in [
            "http://127.0.0.1.evil.example/",
            "http://127.0.0.1:31502/",
            "https://127.0.0.1:31501/",
        ] {
            assert_eq!(
                decide(address, Some(&origin)),
                NavigationDecision::OpenExternally,
                "{address}"
            );
        }
        // A blob or data document is never this window's own page, whatever
        // origin it claims.
        for address in [
            "blob:http://evil.example/uuid",
            "blob:http://127.0.0.1:31501/uuid",
            "data:text/html;base64,PHNjcmlwdD4=",
        ] {
            assert_eq!(decide(address, Some(&origin)), NavigationDecision::Deny, "{address}");
        }
    }

    #[test]
    fn hands_an_uppercase_scheme_to_the_system_like_its_canonical_form() {
        let origin = owned();
        assert_eq!(
            decide("HTTPS://code.verboo.ai/docs", Some(&origin)),
            NavigationDecision::OpenExternally
        );
    }

    #[test]
    fn denies_a_foreign_document_before_the_host_origin_is_known() {
        // The owned origin exists only after the Host reports ready; before that
        // the application protocol is the only document this window may load.
        assert_eq!(
            decide("http://127.0.0.1:31501/session/1", None),
            NavigationDecision::OpenExternally
        );
        assert_eq!(decide("tauri://localhost/index.html", None), NavigationDecision::NavigateHere);
    }
}
