fn main() {
    // Local-only extras live in files that are gitignored; build them in when they exist.
    println!("cargo:rustc-check-cfg=cfg(local_extras)");
    println!("cargo:rerun-if-changed=src/local.rs");
    if std::path::Path::new("src/local.rs").exists() {
        println!("cargo:rustc-cfg=local_extras");
    }
    tauri_build::build()
}
