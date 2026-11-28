//! Own the Node profile's startup protocol and graceful process shutdown.
use serde::Deserialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};
use url::Url;

const PROTOCOL: &str = "VERBOO_HOST_V1\t";

/// Windows starts a console application without a console window when the child
/// is created with this flag. The release application is built as a GUI program,
/// so without it the Host's Node process opens a console window beside the
/// product window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub const STARTUP_DEADLINE: Duration = Duration::from_secs(60);
const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(15);
const QUIT_REQUEST_DEADLINE: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub node: PathBuf,
    pub host: PathBuf,
    pub cli_manifest: PathBuf,
    pub working_directory: PathBuf,
    pub home: Option<PathBuf>,
}

impl RuntimeConfig {
    pub fn read(path: &Path) -> Result<Self, String> {
        let bytes = fs::read(path).map_err(|_| "runtime_config_unreadable")?;
        let mut config: Self =
            serde_json::from_slice(&bytes).map_err(|_| "runtime_config_invalid")?;
        let root = path.parent().ok_or("runtime_config_directory_missing")?;
        for entry in [
            &mut config.node,
            &mut config.host,
            &mut config.cli_manifest,
            &mut config.working_directory,
        ] {
            if entry.is_relative() {
                *entry = root.join(&*entry);
            }
            if !entry.exists() {
                return Err("runtime_artifact_missing".into());
            }
        }
        Ok(config)
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostEvent {
    Ready { url: String },
    Fatal { code: String },
    Stopped,
}

/// Correlated reply to a private exit-admission request; never enters the Host lifecycle stream.
#[derive(Debug, Deserialize)]
struct QuitReply {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    lease: Option<u64>,
}

/// An admission result that distinguishes a proven idle lease from a required user decision.
pub enum QuitReservation {
    Reserved(u64),
    Confirm,
}

/// Accept only the local profile's authenticated root; never trust a child-provided remote origin.
pub fn authenticated_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "host_url_invalid")?;
    let pairs: Vec<_> = url.query_pairs().collect();
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.fragment().is_some()
        || pairs.len() != 1
        || pairs[0].0 != "token"
        || pairs[0].1.len() < 20
        || !pairs[0]
            .1
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("host_url_invalid".into());
    }
    Ok(url)
}

pub struct HostProcess {
    child: Child,
    input: Option<ChildStdin>,
    quit_responses: Receiver<QuitReply>,
    next_quit_request: u64,
}

impl HostProcess {
    pub fn start(
        config: &RuntimeConfig,
        home: &Path,
        app_version: &str,
    ) -> Result<(Self, Receiver<HostEvent>), String> {
        fs::create_dir_all(home).map_err(|_| "host_home_unavailable")?;
        // Windows canonicalization produces verbatim paths (\\?\C:\...).
        // Node's entry-point resolver requires the ordinary drive/UNC form.
        let mut command = Command::new(dunce::simplified(&config.node));
        command
            .arg(dunce::simplified(&config.host))
            .arg(dunce::simplified(&config.cli_manifest))
            .current_dir(dunce::simplified(&config.working_directory))
            .env("DSH_HOME", dunce::simplified(home))
            // The packaged application's version is authoritative, even if a
            // parent shell happens to carry a build-time DSH_CLIENT_VERSION.
            .env("DSH_CLIENT_VERSION", app_version)
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|_| "host_spawn_failed")?;
        let input = child.stdin.take();
        let output = child.stdout.take().ok_or("host_output_unavailable")?;
        let (sender, receiver) = mpsc::channel();
        let (quit_sender, quit_receiver) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                // Ordinary plugin logs, including bootstrap URLs, never enter the native log.
                let Some(payload) = line.strip_prefix(PROTOCOL) else {
                    continue;
                };
                if payload.len() > 8192 {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else { continue };
                if value.get("type").and_then(serde_json::Value::as_str) == Some("quit-response") {
                    if let Ok(reply) = serde_json::from_value::<QuitReply>(value) { let _ = quit_sender.send(reply); }
                    continue;
                }
                if let Ok(event) = serde_json::from_value::<HostEvent>(value) {
                    if sender.send(event).is_err() {
                        break;
                    }
                }
            }
        });
        Ok((Self { child, input, quit_responses: quit_receiver, next_quit_request: 0 }, receiver))
    }

    /// Write one correlated request. The only caller holds the process-owner mutex.
    fn quit_request(&mut self, kind: &str, lease: Option<u64>, reservation: Option<u64>) -> Result<(u64, Option<QuitReply>), &'static str> {
        self.next_quit_request = self.next_quit_request.checked_add(1).filter(|id| *id <= 9_007_199_254_740_991).ok_or("quit_request_overflow")?;
        let id = self.next_quit_request;
        let mut request = serde_json::json!({ "type": kind, "requestId": id });
        if let Some(lease) = lease { request["lease"] = serde_json::json!(lease); }
        if let Some(reservation) = reservation { request["reservationRequestId"] = serde_json::json!(reservation); }
        let input = self.input.as_mut().ok_or("quit_host_unavailable")?;
        writeln!(input, "{request}").and_then(|_| input.flush()).map_err(|_| "quit_host_unavailable")?;
        let deadline = Instant::now() + QUIT_REQUEST_DEADLINE;
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { return Ok((id, None)); };
            match self.quit_responses.recv_timeout(remaining) {
                Ok(reply) if reply.request_id == id => return Ok((id, Some(reply))),
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => return Ok((id, None)),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err("quit_host_unavailable"),
            }
        }
    }

    /// Cancel a reservation and wait for Host acknowledgment before offering a cancellable dialog.
    fn cancel_quit(&mut self, lease: Option<u64>, reservation: Option<u64>) -> Result<(), &'static str> {
        let (_, reply) = self.quit_request("quit-cancel", lease, reservation)?;
        if reply.is_some_and(|reply| reply.kind == "cancelled") { Ok(()) } else { Err("quit_check_unavailable") }
    }

    /// Ask the Host to freeze and recheck idle work. An unknown state always requires confirmation.
    pub fn reserve_idle(&mut self) -> Result<QuitReservation, &'static str> {
        let (id, reply) = self.quit_request("quit-reserve", None, None)?;
        let lease = match reply {
            Some(QuitReply { kind, lease: Some(lease), .. }) if kind == "reserved" && lease > 0 => lease,
            Some(reply) if reply.kind == "busy" || reply.kind == "unknown" => return Ok(QuitReservation::Confirm),
            _ => { self.cancel_quit(None, Some(id))?; return Ok(QuitReservation::Confirm); }
        };
        let (_, committed) = self.quit_request("quit-commit", Some(lease), None)?;
        if committed.is_some_and(|reply| reply.kind == "committed") { return Ok(QuitReservation::Reserved(lease)); }
        self.cancel_quit(Some(lease), None)?;
        Ok(QuitReservation::Confirm)
    }

    /// Begin shutdown only after the committed idle lease is revalidated by the Host.
    pub fn finalize_idle(&mut self, lease: u64) -> Result<bool, &'static str> {
        let (_, reply) = self.quit_request("quit-finalize", Some(lease), None)?;
        match reply {
            Some(reply) if reply.kind == "finalized" => Ok(true),
            Some(reply) if reply.kind == "rejected" => { self.cancel_quit(Some(lease), None)?; Ok(false) },
            _ => Err("quit_result_unknown"),
        }
    }

    /// Release an acquired lease if another native shutdown took ownership first.
    pub fn cancel_idle(&mut self, lease: u64) -> Result<(), &'static str> {
        self.cancel_quit(Some(lease), None)
    }

    /// Ask the profile to dispose first. A missed deadline is an error even after killing the child.
    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(mut input) = self.input.take() {
            // A closed pipe can mean the Host already exited; its exit status decides success below.
            let _delivery = input
                .write_all(b"{\"type\":\"shutdown\"}\n")
                .and_then(|_| input.flush());
        }
        let deadline = Instant::now() + SHUTDOWN_DEADLINE;
        loop {
            match self.child.try_wait().map_err(|_| "host_wait_failed")? {
                Some(status) => {
                    return if status.success() {
                        Ok(())
                    } else {
                        Err("host_exit_failed".into())
                    }
                }
                None if Instant::now() >= deadline => {
                    self.child.kill().map_err(|_| "host_kill_failed")?;
                    self.child.wait().map_err(|_| "host_wait_failed")?;
                    return Err("host_shutdown_timeout".into());
                }
                None => thread::sleep(Duration::from_millis(25)),
            }
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        if self.input.is_some() {
            if let Err(code) = self.stop() {
                eprintln!("Verboo Code: {code}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quit_probe(mode: &str) -> (HostProcess, Receiver<HostEvent>, PathBuf) {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let home = std::env::temp_dir().join(format!(
            "verboo-quit-probe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let config = RuntimeConfig {
            node: std::env::var_os("VERBOO_TEST_NODE").map(PathBuf::from).unwrap_or_else(|| "node".into()),
            host: repository.join("apps/desktop/tauri/tests/fixtures/quit-host-probe.mjs"),
            cli_manifest: mode.into(), working_directory: repository, home: None,
        };
        let (host, events) = HostProcess::start(&config, &home, "0.0.0-test").unwrap();
        assert!(matches!(events.recv_timeout(Duration::from_secs(5)), Ok(HostEvent::Ready { .. })));
        (host, events, home)
    }

    #[test]
    fn idle_quit_demultiplexes_replies_without_losing_lifecycle_events() {
        let (mut host, events, home) = quit_probe("idle");
        let QuitReservation::Reserved(lease) = host.reserve_idle().unwrap() else { panic!("idle reservation expected") };
        assert!(host.finalize_idle(lease).unwrap());
        host.stop().unwrap();
        assert!(matches!(events.recv_timeout(Duration::from_secs(2)), Ok(HostEvent::Stopped)));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn busy_and_invalidated_reservations_preserve_a_running_host() {
        for mode in ["busy", "rejected"] {
            let (mut host, events, home) = quit_probe(mode);
            assert!(matches!(host.reserve_idle().unwrap(), QuitReservation::Confirm));
            assert!(host.child.try_wait().unwrap().is_none());
            host.stop().unwrap();
            assert!(matches!(events.recv_timeout(Duration::from_secs(2)), Ok(HostEvent::Stopped)));
            fs::remove_dir_all(home).unwrap();
        }
    }

    #[test]
    fn late_reservation_is_cancelled_before_a_confirmation_is_allowed() {
        let (mut host, _events, home) = quit_probe("lost-reserve");
        assert!(matches!(host.reserve_idle().unwrap(), QuitReservation::Confirm));
        assert!(host.child.try_wait().unwrap().is_none());
        host.stop().unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn unknown_finalize_does_not_force_the_host_to_stop() {
        let (mut host, _events, home) = quit_probe("lost-finalize");
        let QuitReservation::Reserved(lease) = host.reserve_idle().unwrap() else { panic!("idle reservation expected") };
        assert_eq!(host.finalize_idle(lease).unwrap_err(), "quit_result_unknown");
        assert!(host.child.try_wait().unwrap().is_none());
        host.stop().unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn accepts_only_the_authenticated_local_root() {
        let token = "a".repeat(32);
        assert!(authenticated_url(&format!("http://127.0.0.1:31501/?token={token}")).is_ok());
        for address in [
            format!("https://example.com/?token={token}"),
            format!("http://localhost:31501/?token={token}"),
            format!("http://127.0.0.1:31501/path?token={token}"),
            format!("http://user@127.0.0.1:31501/?token={token}"),
            format!("http://127.0.0.1:31501/?token={token}&extra=1"),
            "http://127.0.0.1:31501/?token=short".into(),
        ] {
            assert_eq!(authenticated_url(&address).unwrap_err(), "host_url_invalid");
        }
    }

    #[cfg(windows)]
    #[test]
    fn hides_the_host_console_window() {
        // Win32 CREATE_NO_WINDOW, the documented value. The release application is
        // a GUI program, so the Host's console process would otherwise open a
        // visible console window beside the product window.
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[test]
    fn shutdown_disposes_the_real_profile_and_releases_its_listener() {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let home = std::env::temp_dir().join(format!(
            "verboo-tauri-rust-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config = RuntimeConfig {
            node: std::env::var_os("VERBOO_TEST_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| "node".into()),
            host: repository.join("apps/desktop/tauri/host.mjs"),
            cli_manifest: repository.join("apps/cli/package.json"),
            working_directory: repository,
            home: None,
        };
        let (mut host, events) = HostProcess::start(&config, &home, "0.0.0-test").unwrap();
        let HostEvent::Ready { url } = events.recv_timeout(STARTUP_DEADLINE).unwrap() else {
            panic!("Host did not become ready")
        };
        let url = authenticated_url(&url).unwrap();
        let address = ("127.0.0.1", url.port().unwrap());
        assert!(std::net::TcpStream::connect(address).is_ok());
        host.stop().unwrap();
        assert!(std::net::TcpStream::connect(address).is_err());
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)),
            Ok(HostEvent::Stopped)
        ));
        assert!(events.recv_timeout(Duration::from_secs(2)).is_err());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn passes_packaged_version_to_the_host_process() {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let home = std::env::temp_dir().join(format!(
            "verboo-version-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config = RuntimeConfig {
            node: std::env::var_os("VERBOO_TEST_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| "node".into()),
            host: repository.join("apps/desktop/tauri/tests/fixtures/host-version-probe.mjs"),
            cli_manifest: repository.join("apps/cli/package.json"),
            working_directory: repository,
            home: None,
        };
        let (mut host, events) = HostProcess::start(&config, &home, "0.2.2-alpha.31").unwrap();
        let HostEvent::Ready { url } = events.recv_timeout(STARTUP_DEADLINE).unwrap() else {
            panic!("version probe did not become ready")
        };
        assert_eq!(url, "0.2.2-alpha.31");
        host.stop().unwrap();
        fs::remove_dir_all(home).unwrap();
    }
}
