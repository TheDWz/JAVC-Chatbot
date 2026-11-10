import Capacitor
import CryptoKit
import Foundation
import Security
import UIKit

/// What the page can't do on its own inside a WKWebView (mobile/native.js is the JavaScript side). The same methods, with
/// the same arguments and answers, as android/.../JavcPlugin.java: HTTP with a streamed body and no CORS, private files,
/// Keychain-encrypted API keys, the rich-reply sandbox, the clipboard and the browser.
/// Only the app's own page can call it: MainViewController drops bridge messages from any other frame.
@objc(JavcPlugin)
public class JavcPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "JavcPlugin"
    public let jsName = "Javc"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "httpStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "httpAbort", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fsRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fsWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fsRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fsList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fsRename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cryptoAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "encrypt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "decrypt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sandboxCreate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveFile", returnType: CAPPluginReturnPromise),
    ]

    /// Keeps the save screen's delegate alive while it's open (the picker only holds it weakly).
    private var saving: SaveFileDelegate?

    private lazy var requests = HttpRequests(plugin: self)

    // ---- HTTP: resolves with {status, headers} as soon as they arrive, then streams the body as "http" events ----

    /// Starts an HTTP request. The call resolves with {status, headers} once they arrive; the body then follows as "http"
    /// events ({id, type: data|end|error}), data as base64. Options: id, url, method, headers, body (text).
    @objc func httpStart(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let raw = call.getString("url"), let url = URL(string: raw) else {
            call.reject("Missing request id or URL")
            return
        }
        guard url.scheme == "http" || url.scheme == "https" else {
            call.reject("Only http and https URLs are supported")
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = call.getString("method", "GET")
        for (k, v) in call.getObject("headers", [:]) {
            if let v = v as? String { req.setValue(v, forHTTPHeaderField: k) }
        }
        if let body = call.getString("body") { req.httpBody = Data(body.utf8) }
        requests.start(id: id, request: req, call: call)
    }

    /// Stops request `id`. A request that already finished is left alone.
    @objc func httpAbort(_ call: CAPPluginCall) {
        requests.abort(id: call.getString("id", ""))
        call.resolve()
    }

    /// Sends one "http" event for request `id`: data (base64), end, or error (with a message).
    fileprivate func emit(_ id: String, _ type: String, _ value: String?) {
        var ev: [String: Any] = ["id": id, "type": type]
        if let value { ev[type == "data" ? "data" : "message"] = value }
        notifyListeners("http", data: ev)
    }

    // ---- Files, inside the app's private storage only ----

    /// The app's data folder (Application Support/javc), left out of iCloud and computer backups.
    private lazy var base: URL = {
        var dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("javc", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return dir.standardizedFileURL
    }()

    /// The file at `rel` inside the data folder; anything that resolves outside it is refused.
    private func fileAt(_ rel: String?) throws -> URL {
        let rel = rel ?? ""
        let parts = rel.split(separator: "/", omittingEmptySubsequences: false)
        if rel.hasPrefix("/") || parts.contains(where: { $0 == ".." || $0 == "." }) { throw JavcError("Invalid file name") }
        let f = (rel.isEmpty ? base : base.appendingPathComponent(rel)).standardizedFileURL
        guard f.path == base.path || f.path.hasPrefix(base.path + "/") else { throw JavcError("Invalid file name") }
        return f
    }

    private func isFile(_ url: URL) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &dir) && !dir.boolValue
    }

    /// Reads a text file: {exists, text}. A missing file is {exists: false}, not an error.
    @objc func fsRead(_ call: CAPPluginCall) {
        do {
            let f = try fileAt(call.getString("path"))
            guard isFile(f) else { return call.resolve(["exists": false]) }
            call.resolve(["exists": true, "text": try String(contentsOf: f, encoding: .utf8)])
        } catch { call.reject(error.localizedDescription) }
    }

    /// Writes a text file atomically (a temporary file renamed over the old one), so a crash can't leave half a file.
    @objc func fsWrite(_ call: CAPPluginCall) {
        do {
            let f = try fileAt(call.getString("path"))
            try FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(call.getString("text", "").utf8).write(to: f, options: .atomic)
            call.resolve()
        } catch { call.reject(error.localizedDescription) }
    }

    /// Deletes a file; a file that is already gone is fine.
    @objc func fsRemove(_ call: CAPPluginCall) {
        do {
            let f = try fileAt(call.getString("path"))
            if FileManager.default.fileExists(atPath: f.path) { try FileManager.default.removeItem(at: f) }
            call.resolve()
        } catch { call.reject(error.localizedDescription) }
    }

    /// The names in a folder: {names}; a missing folder gives an empty list.
    @objc func fsList(_ call: CAPPluginCall) {
        do {
            let dir = try fileAt(call.getString("path", ""))
            call.resolve(["names": (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []])
        } catch { call.reject(error.localizedDescription) }
    }

    /// Renames a file, replacing any file already at the new name.
    @objc func fsRename(_ call: CAPPluginCall) {
        do {
            let from = try fileAt(call.getString("from")), to = try fileAt(call.getString("to"))
            if FileManager.default.fileExists(atPath: to.path) { _ = try FileManager.default.replaceItemAt(to, withItemAt: from) }
            else { try FileManager.default.moveItem(at: from, to: to) }
            call.resolve()
        } catch { call.reject(error.localizedDescription) }
    }

    // ---- API keys: AES-GCM with a random key kept in the Keychain (this device only); stored as base64(nonce | ciphertext | tag) ----

    private static let keyService = "io.github.thedwz.javcchatbot"
    private static let keyAccount = "javc-api-keys"

    private var key: SymmetricKey? // read once; plugin calls run one at a time on Capacitor's bridge queue

    /// The app's AES key from the Keychain, created on first use.
    private func secretKey() throws -> SymmetricKey {
        if let key { return key }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.keyService,
                                    kSecAttrAccount as String: Self.keyAccount, kSecReturnData as String: true]
        var out: CFTypeRef?
        let found = SecItemCopyMatching(query as CFDictionary, &out)
        if found == errSecSuccess, let data = out as? Data, data.count == 32 {
            let stored = SymmetricKey(data: data)
            key = stored
            return stored
        }
        if found != errSecItemNotFound { throw JavcError("The Keychain can't be read (error \(found))") }
        let fresh = SymmetricKey(size: .bits256)
        let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.keyService,
                                  kSecAttrAccount as String: Self.keyAccount, kSecValueData as String: fresh.withUnsafeBytes { Data($0) },
                                  kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw JavcError("The Keychain can't save a key (error \(added))") }
        key = fresh
        return fresh
    }

    /// Encrypts `text` with a fresh nonce; returns base64(nonce | ciphertext | tag), the same layout as the Android app.
    private func encryptText(_ text: String) throws -> String {
        guard let combined = try AES.GCM.seal(Data(text.utf8), using: secretKey()).combined else { throw JavcError("Encryption failed") }
        return combined.base64EncodedString()
    }

    /// Decrypts what encryptText produced; throws if the data was changed or the key is not the one it was made with.
    private func decryptText(_ data: String) throws -> String {
        guard let all = Data(base64Encoded: data), all.count >= 28 else { throw JavcError("Not an encrypted key") } // nonce + tag, so "" works too
        let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: all), using: secretKey())
        guard let text = String(data: plain, encoding: .utf8) else { throw JavcError("Not an encrypted key") }
        return text
    }

    /// Whether the Keychain works here: {available}. A real round trip, as on Android.
    @objc func cryptoAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": (try? decryptText(encryptText("javc"))) == "javc"])
    }

    /// Encrypts an API key: {text} in, {data} out.
    @objc func encrypt(_ call: CAPPluginCall) {
        do { call.resolve(["data": try encryptText(call.getString("text", ""))]) } catch { call.reject(error.localizedDescription) }
    }

    /// Decrypts an API key: {data} in, {text} out.
    @objc func decrypt(_ call: CAPPluginCall) {
        do { call.resolve(["text": try decryptText(call.getString("data", ""))]) } catch { call.reject(error.localizedDescription) }
    }

    // ---- Rich replies: model-written pages served from their own scheme, in an opaque sandboxed origin (like the desktop) ----

    static let sandboxScheme = "javc-sandbox" // allowed by frame-src in the page's CSP (mobile/build.mjs)
    static let sandboxCSP = "sandbox allow-scripts" // every page gets at least this; Lib.richDoc adds the CSS/JS-off rules
    private static let sandboxMax = 2_100_000 // the page limits the model's HTML to 2,000,000 characters
    private static let docs = SandboxDocs()

    /// Stores a rich-reply page and its Content-Security-Policy ({html, csp}) and returns its URL ({url}). The policy must be
    /// "sandbox allow-scripts", optionally followed by more rules, so every page runs in an opaque origin.
    @objc func sandboxCreate(_ call: CAPPluginCall) {
        let csp = call.getString("csp", Self.sandboxCSP)
        guard let html = call.getString("html"), html.utf16.count <= Self.sandboxMax else {
            return call.reject("This content is too large to display")
        }
        guard csp == Self.sandboxCSP || csp.hasPrefix(Self.sandboxCSP + "; "), !csp.contains("\r"), !csp.contains("\n") else {
            return call.reject("Invalid sandbox policy")
        }
        // the same page gets the same id, so re-renders reuse it instead of filling the store with copies
        let id = SHA256.hash(data: Data((csp + "\n" + html).utf8)).map { String(format: "%02x", $0) }.joined()
        Self.docs.put(id, html: html, csp: csp)
        call.resolve(["url": "\(Self.sandboxScheme)://doc/\(id)"])
    }

    /// The stored page and policy for a sandbox URL, or nil. Called by SandboxSchemeHandler.
    static func sandboxDoc(_ url: URL) -> (html: String, csp: String)? {
        guard url.host == "doc" else { return nil }
        return docs.get(String(url.path.dropFirst()))
    }

    // ---- Clipboard and browser ----

    /// Copies {text} to the clipboard.
    @objc func copyText(_ call: CAPPluginCall) {
        let text = call.getString("text", "")
        DispatchQueue.main.async {
            UIPasteboard.general.string = text
            call.resolve()
        }
    }

    /// Saves {data} (text) to a file the user picks with the system's save screen, suggesting {name}. Resolves {saved: false}
    /// if they cancel. Used for chat exports. The text goes through a temporary file, removed once the screen closes.
    @objc func saveFile(_ call: CAPPluginCall) {
        let name = (call.getString("name") ?? "export").replacingOccurrences(of: "/", with: "-")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = dir.appendingPathComponent(name.isEmpty ? "export" : name)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data((call.getString("data") ?? "").utf8).write(to: file, options: [.atomic, .completeFileProtection])
        } catch {
            return call.reject(error.localizedDescription)
        }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else {
                try? FileManager.default.removeItem(at: dir)
                return call.reject("There's nowhere to show the save screen")
            }
            let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
            let delegate = SaveFileDelegate { saved in
                try? FileManager.default.removeItem(at: dir)
                self.saving = nil
                call.resolve(["saved": saved])
            }
            picker.delegate = delegate
            self.saving = delegate
            vc.present(picker, animated: true)
        }
    }

    /// Opens {url} (http or https only) in the browser, for MCP sign-in pages.
    @objc func openUrl(_ call: CAPPluginCall) {
        let raw = call.getString("url", "")
        guard raw.hasPrefix("https://") || raw.hasPrefix("http://"), let url = URL(string: raw) else {
            return call.reject("Only web addresses can be opened")
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url) { ok in ok ? call.resolve() : call.reject("There's no browser to open the sign-in page") }
        }
    }
}

struct JavcError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// The 300 most recently used sandbox pages: id -> (html, csp).
final class SandboxDocs {
    private let lock = NSLock()
    private var docs: [String: (html: String, csp: String)] = [:]
    private var order: [String] = [] // least recently used first

    func put(_ id: String, html: String, csp: String) {
        lock.withLock {
            docs[id] = (html, csp)
            order.removeAll { $0 == id }
            order.append(id)
            if order.count > 300 { docs.removeValue(forKey: order.removeFirst()) }
        }
    }

    func get(_ id: String) -> (html: String, csp: String)? {
        lock.withLock {
            guard let doc = docs[id] else { return nil }
            order.removeAll { $0 == id }
            order.append(id) // showing a page counts as using it
            return doc
        }
    }
}

/// The plugin's HTTP requests on one URLSession, so the body can be streamed as it arrives.
private final class HttpRequests: NSObject, URLSessionDataDelegate {
    private final class Entry {
        let id: String
        var call: CAPPluginCall? // until the status and headers arrive
        init(id: String, call: CAPPluginCall) { self.id = id; self.call = call }
    }

    private weak var plugin: JavcPlugin?
    private let lock = NSLock()
    private var byTask: [Int: Entry] = [:]
    private var tasks: [String: URLSessionDataTask] = [:]
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral // no cache, cookies or credentials kept between requests
        c.timeoutIntervalForRequest = 300 // the same 5 minutes Node's fetch waits on the desktop
        c.timeoutIntervalForResource = 7 * 24 * 3600
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1 // events go out in the order they arrive
        return URLSession(configuration: c, delegate: self, delegateQueue: queue)
    }()

    init(plugin: JavcPlugin) { self.plugin = plugin }

    func start(id: String, request: URLRequest, call: CAPPluginCall) {
        let task = session.dataTask(with: request)
        lock.withLock { byTask[task.taskIdentifier] = Entry(id: id, call: call); tasks[id] = task }
        task.resume()
    }

    func abort(id: String) {
        let task = lock.withLock { tasks.removeValue(forKey: id) }
        task?.cancel()
    }

    private func entry(_ task: URLSessionTask) -> Entry? { lock.withLock { byTask[task.taskIdentifier] } }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let e = entry(dataTask), let call = e.call else { return completionHandler(.cancel) }
        e.call = nil
        let http = response as? HTTPURLResponse
        var headers: [String: Any] = [:]
        for (k, v) in http?.allHeaderFields ?? [:] { if let k = k as? String { headers[k.lowercased()] = "\(v)" } }
        call.resolve(["status": http?.statusCode ?? 200, "headers": headers])
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let e = entry(dataTask), !data.isEmpty else { return }
        plugin?.emit(e.id, "data", data.base64EncodedString())
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let e: Entry? = lock.withLock {
            guard let e = byTask.removeValue(forKey: task.taskIdentifier) else { return nil }
            tasks.removeValue(forKey: e.id)
            return e
        }
        guard let e else { return }
        if let call = e.call { return call.reject(error?.localizedDescription ?? "Network error") } // never got an answer
        if let error { plugin?.emit(e.id, "error", error.localizedDescription) } else { plugin?.emit(e.id, "end", nil) }
    }
}

/// Reports whether the save screen saved the file or was cancelled, once.
final class SaveFileDelegate: NSObject, UIDocumentPickerDelegate {
    private var done: ((Bool) -> Void)?
    init(_ done: @escaping (Bool) -> Void) { self.done = done }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(!urls.isEmpty) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(false) }
    private func finish(_ saved: Bool) { done?(saved); done = nil }
}
