//! Durable, limited desktop layout snapshots shared by local application windows.
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    path::Path,
};

const FILE: &str = "desktop-layout.json";
const LOCK: &str = "desktop-layout.lock";
const MAX_FILE: u64 = 8 * 1024 * 1024;
const MAX_VALUE: usize = 1024 * 1024;

fn allowed(key: &str) -> bool {
    key.len() <= 2048
        && (key == "dsh.verboo.layout.v1"
            || key == "dsh.terminal.shell"
            || key.starts_with("dsh.sidebar-right.v1.")
            || key.starts_with("dsh.terminal.binding.v1.")
            || key.starts_with("dsh.terminal.close.v1."))
}

fn open(root: &Path) -> Result<File, &'static str> {
    fs::create_dir_all(root).map_err(|_| "layout_storage_unavailable")?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(root.join(LOCK))
        .map_err(|_| "layout_storage_unavailable")?;
    lock.lock().map_err(|_| "layout_storage_unavailable")?;
    Ok(lock)
}

fn read_locked(root: &Path) -> Result<BTreeMap<String, String>, &'static str> {
    let path = root.join(FILE);
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    if fs::metadata(&path)
        .map_err(|_| "layout_storage_unavailable")?
        .len()
        > MAX_FILE
    {
        return Err("layout_storage_invalid");
    }
    let bytes = fs::read(path).map_err(|_| "layout_storage_unavailable")?;
    let map: BTreeMap<String, String> =
        serde_json::from_slice(&bytes).map_err(|_| "layout_storage_invalid")?;
    if map
        .iter()
        .any(|(key, value)| !allowed(key) || value.len() > MAX_VALUE)
    {
        return Err("layout_storage_invalid");
    }
    Ok(map)
}

pub fn read(root: &Path) -> Result<BTreeMap<String, String>, &'static str> {
    let _lock = open(root)?;
    read_locked(root)
}

pub fn write(root: &Path, key: &str, value: Option<String>) -> Result<(), &'static str> {
    if !allowed(key) || value.as_ref().is_some_and(|v| v.len() > MAX_VALUE) {
        return Err("layout_storage_invalid");
    }
    let _lock = open(root)?;
    let mut map = read_locked(root)?;
    match value {
        Some(value) => {
            map.insert(key.to_owned(), value);
        }
        None => {
            map.remove(key);
        }
    }
    let bytes = serde_json::to_vec(&map).map_err(|_| "layout_storage_invalid")?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("layout_storage_invalid");
    }
    let temp = root.join(format!("desktop-layout-{}.tmp", std::process::id()));
    fs::write(&temp, bytes).map_err(|_| "layout_storage_unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))
            .map_err(|_| "layout_storage_unavailable")?;
    }
    fs::rename(&temp, root.join(FILE)).map_err(|_| "layout_storage_unavailable")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_writes_keep_independent_session_layouts() {
        let root =
            std::env::temp_dir().join(format!("verboo-layout-concurrent-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let workers: Vec<_> = (0..12)
            .map(|index| {
                let root = root.clone();
                std::thread::spawn(move || {
                    write(
                        &root,
                        &format!("dsh.sidebar-right.v1.{index}"),
                        Some(index.to_string()),
                    )
                    .unwrap()
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(read(&root).unwrap().len(), 12);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_layout_keys_are_persisted_and_removed() {
        let root = std::env::temp_dir().join(format!("verboo-layout-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        write(&root, "dsh.verboo.layout.v1", Some("layout".into())).unwrap();
        write(&root, "dsh.sidebar-right.v1.session", Some("tabs".into())).unwrap();
        assert_eq!(read(&root).unwrap().len(), 2);
        assert!(write(&root, "token", Some("secret".into())).is_err());
        assert!(write(&root, "dsh.terminal.shell", Some("x".repeat(MAX_VALUE + 1))).is_err());
        write(&root, "dsh.sidebar-right.v1.session", None).unwrap();
        assert_eq!(
            read(&root)
                .unwrap()
                .get("dsh.verboo.layout.v1")
                .map(String::as_str),
            Some("layout")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
