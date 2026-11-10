//! Install the per-user Chrome Native Messaging manifest for the desktop app.

use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
};
#[cfg(windows)]
use std::process::Command;
use tauri::{AppHandle, Manager};

const HOST_NAME: &str = "ai.verbeux.verboo_code.browser_bridge";

#[derive(Serialize)]
struct Manifest<'a> {
    name: &'static str,
    description: &'static str,
    path: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    allowed_origins: [String; 1],
}

/// Register the packaged host for Chrome when the Web Store id is configured at build time.
pub fn register(app: &AppHandle) -> Result<(), &'static str> {
    let Some(extension_id) = option_env!("VERBOO_CHROME_EXTENSION_ID") else {
        eprintln!("Verboo Code: browser_native_host_extension_id_not_configured");
        return Ok(());
    };
    if extension_id.len() != 32 || !extension_id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)) {
        return Err("browser_extension_id_invalid");
    }
    let host_path = host_executable(app)?;
    if !host_path.is_file() {
        return Err("browser_native_host_missing");
    }
    let host_path = absolute_path(&host_path)?;
    let host_path = host_path.to_str().ok_or("browser_native_host_path_invalid")?;
    let manifest_path = manifest_path()?;
    let manifest = Manifest {
        name: HOST_NAME,
        description: "Verboo Code Chrome browser bridge",
        path: host_path,
        kind: "stdio",
        allowed_origins: [format!("chrome-extension://{extension_id}/")],
    };
    write_manifest(&manifest_path, &manifest)?;
    #[cfg(windows)]
    register_windows_manifest(&manifest_path)?;
    Ok(())
}

fn host_executable(app: &AppHandle) -> Result<PathBuf, &'static str> {
    if let Some(path) = env::var_os("VERBOO_BROWSER_NATIVE_HOST") {
        return Ok(PathBuf::from(path));
    }
    let resource_dir = app.path().resource_dir().map_err(|_| "browser_native_host_path_unavailable")?;
    Ok(resource_dir.join("native-host").join(executable_name()))
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "verboo-browser-native-host.exe"
    } else {
        "verboo-browser-native-host"
    }
}

fn manifest_path() -> Result<PathBuf, &'static str> {
    let home = home_directory().ok_or("browser_native_host_home_unavailable")?;
    #[cfg(windows)]
    {
        let root = env::var_os("LOCALAPPDATA")
            .or_else(|| env::var_os("APPDATA"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"));
        return Ok(root.join("Verboo Code/NativeMessagingHosts").join(format!("{HOST_NAME}.json")));
    }
    #[cfg(target_os = "macos")]
    {
        return Ok(home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts").join(format!("{HOST_NAME}.json")));
    }
    #[cfg(target_os = "linux")]
    {
        return Ok(home.join(".config/google-chrome/NativeMessagingHosts").join(format!("{HOST_NAME}.json")));
    }
    #[allow(unreachable_code)]
    Err("browser_native_host_platform_unsupported")
}

fn home_directory() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn absolute_path(path: &Path) -> Result<PathBuf, &'static str> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(|_| "browser_native_host_path_invalid")
    }
}

fn write_manifest(path: &Path, manifest: &Manifest<'_>) -> Result<(), &'static str> {
    let directory = path.parent().ok_or("browser_native_host_manifest_path_invalid")?;
    fs::create_dir_all(directory).map_err(|_| "browser_native_host_manifest_directory_unavailable")?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|_| "browser_native_host_manifest_invalid")?;
    fs::write(&temporary, bytes).map_err(|_| "browser_native_host_manifest_write_failed")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|_| "browser_native_host_manifest_permissions_failed")?;
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|_| "browser_native_host_manifest_publish_failed")?;
    }
    fs::rename(&temporary, path).map_err(|_| "browser_native_host_manifest_publish_failed")?;
    Ok(())
}

#[cfg(windows)]
fn register_windows_manifest(path: &Path) -> Result<(), &'static str> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;
    let registry_key = format!("HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}");
    let status = Command::new("reg.exe")
        .args(["add", registry_key.as_str(), "/ve", "/t", "REG_SZ", "/d"])
        .arg(path)
        .args(["/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|_| "browser_native_host_registry_unavailable")?;
    if !status.success() {
        return Err("browser_native_host_registry_write_failed");
    }
    Ok(())
}
