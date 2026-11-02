import Cocoa
import Carbon.HIToolbox
import WebKit

final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var panel: OverlayPanel!
    private var webView: WKWebView!
    private var settingsWindow: NSWindow?
    private var settingsWebView: WKWebView!
    private var statusItem: NSStatusItem!
    private var targetURL = URL(string: "http://127.0.0.1:8787/")!
    private var retryWorkItem: DispatchWorkItem?
    private var dragStartOrigin: NSPoint?
    private var isDragging = false
    private var baseHeight: CGFloat = 200
    private let showNotification = Notification.Name("com.local.ting-sync.overlay.show")
    private let settingsNotification = Notification.Name("com.local.ting-sync.overlay.settings")
    private var eventHandlerRef: EventHandlerRef?
    private var hotKeyRefs: [UInt32: EventHotKeyRef] = [:]
    private let hotKeySignature: OSType = 0x54535542
    private let hotKeyToggleSubtitle: UInt32 = 1
    private let hotKeyToggleSettings: UInt32 = 2

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if anotherInstanceIsRunning() {
            let wantsSettings = CommandLine.arguments.contains("--settings")
            DistributedNotificationCenter.default().post(
                name: wantsSettings ? settingsNotification : showNotification,
                object: nil
            )
            NSApp.terminate(nil)
            return
        }
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(handleShowRequest),
            name: showNotification,
            object: nil
        )
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(handleSettingsRequest),
            name: settingsNotification,
            object: nil
        )
        parseArguments()
        buildPanel()
        buildStatusItem()
        installHotKeyHandler()
        registerHotKeys()
    }

    private func anotherInstanceIsRunning() -> Bool {
        guard let bundleID = Bundle.main.bundleIdentifier else { return false }
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .contains { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    }

    @objc private func handleShowRequest(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            self?.showPanel()
        }
    }

    @objc private func handleSettingsRequest(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            self?.toggleSettings()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        return true
    }

    private func showPanel() {
        guard panel != nil else { return }
        panel.orderFrontRegardless()
    }

    func applicationWillTerminate(_ notification: Notification) {
        saveFrame()
    }

    private func parseArguments() {
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--url"),
           index + 1 < args.count,
           let url = URL(string: args[index + 1]) {
            targetURL = url
        }
    }

    private func defaultFrame() -> NSRect {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width = min(max(visible.width * 0.68, 720), 1180)
        let height = baseHeight
        return NSRect(x: visible.midX - width / 2, y: visible.minY + 56, width: width, height: height)
    }

    private func buildPanel() {
        var frame = defaultFrame()
        if let saved = UserDefaults.standard.string(forKey: "barFrame") {
            let candidate = NSRectFromString(saved)
            if candidate.width >= 480, candidate.height >= 120,
               NSScreen.screens.contains(where: { $0.visibleFrame.intersects(candidate) }) {
                frame = candidate
            }
        }

        panel = OverlayPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.delegate = self
        panel.title = "同步字幕"

        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.clear.cgColor
        panel.contentView = content

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "sync")
        webView = WKWebView(frame: content.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        content.addSubview(webView)

        loadPage()
        panel.orderFrontRegardless()
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: "captions.bubble",
                accessibilityDescription: "同步字幕"
            )
            button.image?.isTemplate = true
        }

        let menu = NSMenu()
        let toggle = NSMenuItem(title: "显示 / 隐藏字幕", action: #selector(togglePanel), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)

        let settings = NSMenuItem(title: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        let reload = NSMenuItem(title: "重新载入", action: #selector(reloadPage), keyEquivalent: "")
        reload.target = self
        menu.addItem(reload)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出字幕", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
    }

    private func loadPage() {
        var request = URLRequest(url: targetURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        webView.load(request)
    }

    private func scheduleRetry() {
        retryWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.loadPage()
        }
        retryWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: item)
    }

    private func saveFrame() {
        guard panel != nil else { return }
        let saved = NSRect(x: panel.frame.minX, y: panel.frame.minY, width: panel.frame.width, height: baseHeight)
        UserDefaults.standard.set(NSStringFromRect(saved), forKey: "barFrame")
    }

    @objc private func togglePanel() {
        toggleSubtitlePanel()
    }

    private func toggleSubtitlePanel() {
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            panel.orderFrontRegardless()
        }
    }

    @objc private func openSettings() {
        showSettings()
    }

    @objc private func toggleSettings() {
        if settingsWindow?.isVisible == true {
            settingsWindow?.close()
        } else {
            showSettings()
        }
    }

    private func showSettings() {
        if settingsWindow == nil {
            let frame = NSRect(x: 0, y: 0, width: 560, height: 680)
            let window = NSWindow(
                contentRect: frame,
                styleMask: [.titled, .closable, .miniaturizable],
                backing: .buffered,
                defer: false
            )
            window.title = "同步字幕设置"
            window.isReleasedWhenClosed = false
            window.isExcludedFromWindowsMenu = false
            window.level = .floating
            window.delegate = self
            window.center()
            let config = WKWebViewConfiguration()
            config.userContentController.add(self, name: "sync")
            let web = WKWebView(frame: frame, configuration: config)
            web.navigationDelegate = self
            window.contentView = web
            settingsWindow = window
            settingsWebView = web
            if let url = URL(string: "/settings", relativeTo: targetURL) {
                var request = URLRequest(url: url)
                request.cachePolicy = .reloadIgnoringLocalCacheData
                web.load(request)
            }
        }
        if let window = settingsWindow {
            let visibleOnSomeScreen = NSScreen.screens.contains { $0.frame.intersects(window.frame) }
            if !visibleOnSomeScreen {
                window.center()
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    @objc private func reloadPage() {
        loadPage()
    }

    @objc private func quit() {
        saveFrame()
        NSApp.terminate(nil)
    }

    func windowDidMove(_ notification: Notification) {
        if (notification.object as? NSWindow) === panel && !isDragging { saveFrame() }
    }

    func windowDidResize(_ notification: Notification) {
        saveFrame()
    }

    private func installHotKeyHandler() {
        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: OSType(kEventHotKeyPressed)
        )
        InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, event, userData) -> OSStatus in
                guard let userData = userData else { return noErr }
                let owner = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
                var hotKeyID = EventHotKeyID()
                GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hotKeyID
                )
                DispatchQueue.main.async {
                    owner.handleHotKey(hotKeyID.id)
                }
                return noErr
            },
            1,
            &spec,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandlerRef
        )
    }

    private func registerHotKeys() {
        for (_, ref) in hotKeyRefs {
            UnregisterEventHotKey(ref)
        }
        hotKeyRefs.removeAll()
        let stored = UserDefaults.standard.dictionary(forKey: "shortcuts") as? [String: Any] ?? [:]
        registerHotKey(
            name: "toggleSubtitle",
            id: hotKeyToggleSubtitle,
            stored: stored,
            defaultKeyCode: UInt32(kVK_ANSI_B),
            defaultModifiers: UInt32(cmdKey)
        )
        registerHotKey(
            name: "toggleSettings",
            id: hotKeyToggleSettings,
            stored: stored,
            defaultKeyCode: UInt32(kVK_ANSI_S),
            defaultModifiers: UInt32(cmdKey | shiftKey)
        )
    }

    private func registerHotKey(
        name: String,
        id: UInt32,
        stored: [String: Any],
        defaultKeyCode: UInt32,
        defaultModifiers: UInt32
    ) {
        let item = stored[name] as? [String: Any]
        let keyCode = UInt32((item?["keyCode"] as? Int) ?? Int(defaultKeyCode))
        let modifiers = UInt32((item?["modifiers"] as? Int) ?? Int(defaultModifiers))
        var ref: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: hotKeySignature, id: id)
        let status = RegisterEventHotKey(
            keyCode,
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &ref
        )
        if status == noErr, let ref = ref {
            hotKeyRefs[id] = ref
        }
    }

    private func handleHotKey(_ id: UInt32) {
        if id == hotKeyToggleSubtitle {
            toggleSubtitlePanel()
        } else if id == hotKeyToggleSettings {
            toggleSettings()
        }
    }

    private func appendOverlayLog(_ line: String) {
        let directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("English/logs")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("overlay.log")
        let entry = "[\(ISO8601DateFormatter().string(from: Date()))] \(line)\n"
        guard let data = entry.data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: file)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript(
            "JSON.stringify({dpr: devicePixelRatio, w: innerWidth, h: innerHeight, screenW: screen.width, screenH: screen.height})"
        ) { [weak self] result, _ in
            guard let self else { return }
            let backing = self.panel?.backingScaleFactor ?? 0
            self.appendOverlayLog("render \(result ?? "nil") backing=\(backing) frame=\(NSStringFromRect(self.panel.frame)) screen=\(self.panel.screen.map { NSStringFromRect($0.frame) } ?? "nil")")
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        if action == "hide" {
            panel.orderOut(nil)
        } else if action == "openSettings" {
            openSettings()
        } else if action == "toggleSettings" {
            toggleSettings()
        } else if action == "closeSettings" {
            settingsWindow?.close()
        } else if action == "setShortcuts", let shortcuts = body["shortcuts"] as? [String: Any] {
            let allowed = ["toggleSubtitle", "toggleSettings"]
            let filtered = shortcuts.reduce(into: [String: Any]()) { result, pair in
                if allowed.contains(pair.key), let value = pair.value as? [String: Any] {
                    result[pair.key] = [
                        "keyCode": value["keyCode"] as? Int ?? 0,
                        "modifiers": value["modifiers"] as? Int ?? 0
                    ]
                }
            }
            UserDefaults.standard.set(filtered, forKey: "shortcuts")
            registerHotKeys()
        } else if action == "copy", let text = body["text"] as? String {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
        } else if action == "reload" {
            loadPage()
        } else if action == "setBaseHeight",
                  let requested = numberValue(body["height"]) {
            baseHeight = min(max(CGFloat(requested), 140), 360)
            resizePanel(to: baseHeight)
            saveFrame()
        } else if action == "resize",
                  let requested = numberValue(body["height"]) {
            resizePanel(to: CGFloat(requested))
        } else if action == "dragStart" {
            isDragging = true
            dragStartOrigin = panel.frame.origin
        } else if action == "dragMove",
                  let start = dragStartOrigin,
                  let dx = numberValue(body["dx"]),
                  let dy = numberValue(body["dy"]) {
            panel.setFrameOrigin(clampedOrigin(
                x: start.x + CGFloat(dx),
                y: start.y - CGFloat(dy)
            ))
        } else if action == "dragEnd" {
            isDragging = false
            dragStartOrigin = nil
            saveFrame()
        }
    }

    private func resizePanel(to requestedHeight: CGFloat) {
        guard panel != nil else { return }
        let height = min(max(requestedHeight, baseHeight), 360)
        guard abs(panel.frame.height - height) > 1 else { return }
        var frame = panel.frame
        let bottom = frame.minY
        frame.size.height = height
        frame.origin.y = bottom
        frame.origin = clampedOrigin(x: frame.origin.x, y: frame.origin.y)
        panel.setFrame(frame, display: true, animate: false)
    }

    private func numberValue(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let text = value as? String { return Double(text) }
        return nil
    }

    private func clampedOrigin(x: CGFloat, y: CGFloat) -> NSPoint {
        let size = panel.frame.size
        let screens = NSScreen.screens
        guard let first = screens.first else { return NSPoint(x: x, y: y) }
        let minX = screens.map { $0.frame.minX }.min() ?? first.frame.minX
        let maxX = screens.map { $0.frame.maxX }.max() ?? first.frame.maxX
        let minY = screens.map { $0.frame.minY }.min() ?? first.frame.minY
        let maxY = screens.map { $0.frame.maxY }.max() ?? first.frame.maxY
        let keepVisible: CGFloat = 80
        return NSPoint(
            x: min(max(x, minX - size.width + keepVisible), maxX - keepVisible),
            y: min(max(y, minY), maxY - size.height)
        )
    }
}

let app = NSApplication.shared
let appDelegate = AppDelegate()
app.delegate = appDelegate
app.run()
