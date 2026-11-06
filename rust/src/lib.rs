#[cfg(target_os = "android")]
pub mod android;
pub mod app;
pub mod attach;
pub mod core;
pub mod crypto;
pub mod markdown;
pub mod platform;
#[cfg(not(target_os = "android"))]
pub mod preview;
slint::include_modules!();

/// The Android entry point (NativeActivity loads libjavc.so and calls this).
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
fn android_main(app: slint::android::AndroidApp) {
    std::panic::set_hook(Box::new(|p| android::log(&format!("panic: {p}"))));
    android::init(&app);
    slint::android::init(app).expect("Slint Android backend");
    app::init_services(platform::data_dir(), None);
    let ui = match app::build() {
        Ok(ui) => ui,
        Err(e) => return android::log(&format!("could not start: {e}")),
    };
    // debug builds: `adb shell am start -n io.github.thedwz.javcchatbot/.MainActivity --es selftest 1` (see rust/README.md)
    if cfg!(debug_assertions)
        && let Some(mode) = android::self_test_mode()
    {
        let report = |r: Result<(), String>| match r {
            Ok(()) => android::log("SELFTEST PASS"),
            Err(e) => android::log(&format!("SELFTEST FAIL: {e}")),
        };
        match mode.strip_prefix("carryover:") {
            Some(key) => app::carry_over_test(key.to_string(), report), // after installing over the Capacitor app
            None => app::self_test(report, std::env::split_paths(&mode).filter(|p| p.is_absolute()).collect()), // "1", or files to attach
        }
    }
    if let Err(e) = slint::ComponentHandle::run(&ui) {
        android::log(&format!("event loop: {e}"));
    }
}
