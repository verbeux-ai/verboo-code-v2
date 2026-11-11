fn main() {
    println!("cargo:rerun-if-env-changed=VERBOO_CHROME_EXTENSION_ID");
    tauri_build::build()
}
