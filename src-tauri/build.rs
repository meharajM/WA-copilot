use std::{env, fs, path::PathBuf};

const PILOT_ICON_PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 208, 72, 217, 242, 31, 0, 4,
    56, 2, 64, 193, 123, 6, 5, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let icon_path = manifest_dir.join("icons/icon.png");
    fs::create_dir_all(icon_path.parent().expect("icon directory")).expect("create icon directory");
    fs::write(icon_path, PILOT_ICON_PNG).expect("write pilot icon");

    tauri_build::build()
}
