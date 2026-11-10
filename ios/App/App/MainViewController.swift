import Capacitor
import UIKit
import WebKit

/// Capacitor's view controller with the app's own rules on top: the rich-reply sandbox scheme, the native plugin, bridge
/// messages accepted only from the app's own page, and no camera, microphone or motion for page content.
class MainViewController: CAPBridgeViewController {
    private var bridgeGuard: MainFrameOnly?
    private var uiGuard: PermissionGuard?

    /// Serves rich replies from javc-sandbox:, like the desktop's chatbot-sandbox: scheme.
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.setURLSchemeHandler(SandboxSchemeHandler(), forURLScheme: JavcPlugin.sandboxScheme)
        return config
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(JavcPlugin())
        guard let webView, let handler = webView.uiDelegate as? WebViewDelegationHandler else {
            fatalError("Capacitor's web view isn't set up as expected, so the bridge can't be locked to the app page")
        }
        // Capacitor accepts bridge messages from every frame, and `webkit.messageHandlers.bridge` exists in every frame,
        // including the sandboxed ones that run model-written HTML. Only the app's own page may call native code.
        let guardHandler = MainFrameOnly(handler)
        handler.contentController.removeScriptMessageHandler(forName: "bridge")
        handler.contentController.add(guardHandler, name: "bridge")
        bridgeGuard = guardHandler
        // Capacitor grants camera, microphone and motion to any page that asks; this app gives page content none of them.
        let ui = PermissionGuard(handler)
        webView.uiDelegate = ui
        uiGuard = ui
    }
}

/// Passes bridge messages to Capacitor only when they come from the main frame (the app's own page).
final class MainFrameOnly: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        target?.userContentController(controller, didReceive: message)
    }
}

/// Denies media capture and motion; every other UI delegate call goes to Capacitor's handler as before.
final class PermissionGuard: NSObject, WKUIDelegate {
    private weak var target: NSObject?
    init(_ target: NSObject) { self.target = target }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (target?.responds(to: selector) ?? false)
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        target?.responds(to: selector) == true ? target : nil
    }
}

/// Answers javc-sandbox://doc/<id> with the stored page and its Content-Security-Policy, or a 404.
final class SandboxSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        let doc = JavcPlugin.sandboxDoc(url)
        let body = Data((doc?.html ?? "").utf8)
        // an HTTPURLResponse, since a plain URLResponse carries no headers and the CSP would be lost
        let headers = ["Content-Type": doc != nil ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
                       "Content-Security-Policy": doc?.csp ?? JavcPlugin.sandboxCSP, "Cache-Control": "no-store",
                       "Content-Length": String(body.count)]
        guard let res = HTTPURLResponse(url: url, statusCode: doc != nil ? 200 : 404, httpVersion: "HTTP/1.1", headerFields: headers) else {
            return task.didFailWithError(URLError(.cannotParseResponse))
        }
        task.didReceive(res)
        task.didReceive(body)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
