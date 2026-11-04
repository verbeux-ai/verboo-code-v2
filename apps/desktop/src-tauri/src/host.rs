//! Own the Node profile's startup protocol and graceful process shutdown.
use serde::Deserialize;
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
pub const STARTUP_DEADLINE: Duration = Duration::from_secs(60);
const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(15);

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
}

impl HostProcess {
    pub fn start(
        config: &RuntimeConfig,
        home: &Path,
    ) -> Result<(Self, Receiver<HostEvent>), String> {
        fs::create_dir_all(home).map_err(|_| "host_home_unavailable")?;
        let mut child = Command::new(&config.node)
            .arg(&config.host)
            .arg(&config.cli_manifest)
            .current_dir(&config.working_directory)
            .env("DSH_HOME", home)
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| "host_spawn_failed")?;
        let input = child.stdin.take();
        let output = child.stdout.take().ok_or("host_output_unavailable")?;
        let (sender, receiver) = mpsc::channel();
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
                if let Ok(event) = serde_json::from_str::<HostEvent>(payload) {
                    if sender.send(event).is_err() {
                        break;
                    }
                }
            }
        });
        Ok((Self { child, input }, receiver))
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
        let (mut host, events) = HostProcess::start(&config, &home).unwrap();
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
}
