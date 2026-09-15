use std::{env, path::PathBuf, process::Command};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let icon_script = manifest_dir
        .parent()
        .expect("repository root")
        .join("scripts/prepare-tauri-icon.mjs");
    println!("cargo:rerun-if-changed={}", icon_script.display());

    let status = Command::new("node")
        .arg(icon_script)
        .status()
        .expect("Node.js is required to generate the Tauri pilot icon");
    assert!(status.success(), "failed to generate the Tauri pilot icon");

    tauri_build::build()
}
