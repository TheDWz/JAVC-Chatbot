//! The preview window for a rich reply (desktop): a system webview in its own process. The page comes from
//! `rich_doc` and is served with its Content-Security-Policy from a private scheme, inside an outer page that frames it
//! with `sandbox="allow-scripts"`, so the model's HTML runs in an opaque origin that can't reach anything of the app.
//! Links open in the system browser; the window itself never navigates away.
#![cfg(not(target_os = "android"))]
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;
use wry::http::{Response, header::CONTENT_SECURITY_POLICY, header::CONTENT_TYPE};

#[cfg(windows)]
const BASE: &str = "http://javcsandbox.localhost";
#[cfg(not(windows))]
const BASE: &str = "javcsandbox://localhost";

const OUTER: &str = r#"<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe sandbox="allow-scripts" src="doc" title="Rich content"></iframe></body></html>"#;

/// Runs the preview window for the page saved in `file` (written by platform::preview, deleted here once read).
pub fn run(file: &std::path::Path) -> anyhow::Result<()> {
    // WebKitGTK's dmabuf renderer shows a blank page or dies (Wayland "Error 71") on NVIDIA and some other drivers
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: this runs first thing in the preview process, before any other thread exists
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    let text = std::fs::read_to_string(file)?;
    let _ = std::fs::remove_file(file);
    let v: serde_json::Value = serde_json::from_str(&text)?;
    let doc = v["doc"].as_str().unwrap_or("").to_string();
    let csp = v["csp"].as_str().unwrap_or("sandbox allow-scripts").to_string();
    let dark = doc.contains("color-scheme:dark");

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new().with_title("Preview").with_inner_size(tao::dpi::LogicalSize::new(900.0, 700.0)).build(&event_loop)?;
    let external = |url: &str| {
        if crate::markdown::safe_href(url) && !url.starts_with(BASE) {
            let _ = open::that_detached(url);
        }
    };
    let builder = WebViewBuilder::new()
        .with_background_color(if dark { (15, 16, 20, 255) } else { (246, 246, 249, 255) })
        .with_custom_protocol("javcsandbox".into(), move |_id, req| {
            let (body, csp) = match req.uri().path() {
                "/" => (OUTER.to_string(), "default-src 'self'; style-src 'unsafe-inline'; frame-src 'self'".to_string()),
                "/doc" => (doc.clone(), csp.clone()),
                _ => return Response::builder().status(404).body(b"Not found".to_vec().into()).unwrap(),
            };
            Response::builder()
                .header(CONTENT_TYPE, "text/html; charset=utf-8")
                .header(CONTENT_SECURITY_POLICY, csp)
                .body(body.into_bytes().into())
                .unwrap()
        })
        .with_navigation_handler(move |url| {
            if url.starts_with(BASE) {
                return true;
            }
            external(&url);
            false
        })
        .with_new_window_req_handler(move |url, _features| {
            external(&url);
            wry::NewWindowResponse::Deny
        })
        .with_url(format!("{BASE}/"));
    // shortcut: wry has no permission-request hook, so camera/mic/location prompts follow the webview's default
    // (WebKitGTK denies them without a handler; WebView2 asks the user); add one if wry gains it.
    #[cfg(target_os = "linux")]
    let _webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.default_vbox().unwrap())?
    };
    #[cfg(not(target_os = "linux"))]
    let _webview = builder.build(&window)?;

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
            *flow = ControlFlow::Exit;
        }
    });
}
