// Set 8MB stack for the engine binary on Windows (GNU toolchain).
// Python LSP recursion can hit the default 1MB stack on deeply nested ASTs.
fn main() {
    #[cfg(all(target_os = "windows", target_env = "gnu"))]
    println!("cargo:rustc-link-arg-bin=hologram-engine=-Wl,--stack,8388608");
    #[cfg(all(target_os = "windows", target_env = "msvc"))]
    println!("cargo:rustc-link-arg-bin=hologram-engine=/STACK:8388608");
}
