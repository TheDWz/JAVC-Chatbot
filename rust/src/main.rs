// No console window on Windows release builds.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use slint::ComponentHandle;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--preview" {
        return javc::preview::run(std::path::Path::new(&args[2]));
    }
    let dir = javc::platform::data_dir();
    javc::app::init_services(dir, javc::platform::legacy_dir());
    let ui = javc::app::build()?;
    // Debug builds only: JAVC_SELFTEST=1 runs the smoke test against mobile/smoke/mock-api.mjs and exits; =hold keeps the
    // window open and tours the panels afterwards; =tour only tours (safe with real data: it changes nothing).
    match std::env::var("JAVC_SELFTEST").ok().filter(|_| cfg!(debug_assertions)).as_deref() {
        Some("tour") => javc::app::tour(),
        Some(mode) => {
            let hold = mode == "hold";
            let files = std::env::var_os("JAVC_SELFTEST_FILES").map(|f| std::env::split_paths(&f).collect()).unwrap_or_default();
            javc::app::self_test(
                move |r| {
                    match &r {
                        Ok(()) => eprintln!("SELFTEST PASS"),
                        Err(e) => eprintln!("SELFTEST FAIL: {e}"),
                    }
                    if hold {
                        javc::app::tour();
                    } else {
                        std::process::exit(if r.is_ok() { 0 } else { 1 });
                    }
                },
                files,
            );
        }
        None => {}
    }
    ui.run()?;
    Ok(())
}
