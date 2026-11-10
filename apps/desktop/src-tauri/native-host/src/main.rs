//! Chrome Native Messaging process forwarding frames to the authenticated Host socket.

use serde::Deserialize;
use std::{
    env, fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpStream},
    path::PathBuf,
    process, thread,
};

const PROTOCOL_VERSION: u32 = 1;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
struct Bootstrap {
    version: u32,
    port: u16,
    token: String,
}

fn main() {
    if let Err(reason) = run() {
        eprintln!("Verboo browser native host: {reason}");
        process::exit(1);
    }
}

fn run() -> Result<(), &'static str> {
    let origin = env::args()
        .skip(1)
        .find(|argument| argument.starts_with("chrome-extension://"))
        .ok_or("extension_origin_missing")?;
    let extension_id = origin
        .strip_prefix("chrome-extension://")
        .and_then(|value| value.strip_suffix('/'))
        .ok_or("extension_origin_invalid")?;
    if extension_id.len() != 32
        || !extension_id
            .bytes()
            .all(|byte| (b'a'..=b'p').contains(&byte))
    {
        return Err("extension_origin_invalid");
    }
    if let Some(expected) = option_env!("VERBOO_CHROME_EXTENSION_ID") {
        if expected != extension_id {
            return Err("extension_origin_not_allowed");
        }
    }

    let bytes = fs::read(bootstrap_file()).map_err(|_| "host_bootstrap_unavailable")?;
    if bytes.len() > 4096 {
        return Err("host_bootstrap_invalid");
    }
    let bootstrap: Bootstrap =
        serde_json::from_slice(&bytes).map_err(|_| "host_bootstrap_invalid")?;
    if bootstrap.version != PROTOCOL_VERSION
        || bootstrap.port == 0
        || bootstrap.token.len() != 64
        || !bootstrap.token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("host_bootstrap_invalid");
    }

    let mut host =
        TcpStream::connect(("127.0.0.1", bootstrap.port)).map_err(|_| "verboo_host_unavailable")?;
    host.set_nodelay(true)
        .map_err(|_| "local_socket_unavailable")?;
    let handshake = serde_json::json!({
        "type": "hello",
        "version": PROTOCOL_VERSION,
        "token": bootstrap.token,
        "origin": origin,
    });
    host.write_all(
        serde_json::to_string(&handshake)
            .map_err(|_| "local_handshake_failed")?
            .as_bytes(),
    )
    .and_then(|_| host.write_all(b"\n"))
    .map_err(|_| "local_handshake_failed")?;

    let mut host_writer = host.try_clone().map_err(|_| "local_socket_unavailable")?;
    let sender = thread::spawn(move || {
        let result = forward_chrome_input(&mut host_writer);
        if let Err(error) = &result {
            eprintln!("Verboo browser native host: Chrome input failed: {error}");
        }
        let _ = host_writer.shutdown(Shutdown::Both);
        result
    });
    let result = forward_host_output(host);
    drop(sender);
    result
}

fn forward_chrome_input(host: &mut TcpStream) -> io::Result<()> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        let mut prefix = [0_u8; 4];
        match input.read_exact(&mut prefix) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        }
        let length = u32::from_le_bytes(prefix) as usize;
        if length == 0 || length > MAX_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "native message size is invalid",
            ));
        }
        let mut message = vec![0; length];
        input.read_exact(&mut message)?;
        let parsed: serde_json::Value = serde_json::from_slice(&message).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "native message is not JSON")
        })?;
        let encoded = serde_json::to_vec(&parsed).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "native message could not be encoded",
            )
        })?;
        if encoded.len() > MAX_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "native message exceeds its size limit",
            ));
        }
        host.write_all(&encoded)?;
        host.write_all(b"\n")?;
    }
}

fn forward_host_output(host: TcpStream) -> Result<(), &'static str> {
    let mut input = BufReader::new(host.try_clone().map_err(|_| "local_socket_unavailable")?);
    let mut output = io::stdout().lock();
    loop {
        let mut line = Vec::new();
        let read = input
            .by_ref()
            .take((MAX_MESSAGE_BYTES + 2) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| "local_socket_read_failed")?;
        if read == 0 {
            let _ = host.shutdown(Shutdown::Both);
            return Ok(());
        }
        if line.len() > MAX_MESSAGE_BYTES + 1 || !line.ends_with(b"\n") {
            let _ = host.shutdown(Shutdown::Both);
            return Err("host_response_exceeds_native_message_limit");
        }
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        let parsed: serde_json::Value =
            serde_json::from_slice(&line).map_err(|_| "host_response_invalid")?;
        let message = serde_json::to_vec(&parsed).map_err(|_| "host_response_invalid")?;
        if message.is_empty() || message.len() > MAX_MESSAGE_BYTES {
            let _ = host.shutdown(Shutdown::Both);
            return Err("host_response_exceeds_native_message_limit");
        }
        let length = u32::try_from(message.len())
            .map_err(|_| "host_response_exceeds_native_message_limit")?;
        output
            .write_all(&length.to_le_bytes())
            .map_err(|_| "native_output_closed")?;
        output
            .write_all(&message)
            .map_err(|_| "native_output_closed")?;
        output.flush().map_err(|_| "native_output_closed")?;
    }
}

fn bootstrap_file() -> PathBuf {
    let config_root = if cfg!(windows) {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("AppData/Roaming"))
            })
            .unwrap_or_else(|| PathBuf::from("."))
    } else if cfg!(target_os = "macos") {
        home_directory().join("Library/Application Support")
    } else {
        home_directory().join(".config")
    };
    config_root.join("Verboo Code/browser-extension/bridge.json")
}

fn home_directory() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
