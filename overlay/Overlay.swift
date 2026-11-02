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
    private let hotKeyNames: [String: UInt32] = [
        "toggleSubtitle": 1,
        "toggleSettings": 2,
        "play": 3,
        "prev": 4,
        "next": 5,
        "mode": 6,
        "bg": 7,
        "speedUp": 8,
        "speedDown": 9,
        "fontUp": 10,
        "fontDown": 11,
        "settings": 12
    ]
    private var hotKeyNamesById: [UInt32: String] = [:]

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
        seedDefaultShortcutsIfNeeded()
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

    private func seedDefaultShortcutsIfNeeded() {
        guard UserDefaults.standard.dictionary(forKey: "shortcuts") == nil else { return }
        UserDefaults.standard.set([
            "toggleSubtitle": ["key": "b", "keyCode": Int(kVK_ANSI_B), "modifiers": Int(cmdKey)],
            "toggleSettings": ["key": "s", "keyCode": Int(kVK_ANSI_S), "modifiers": Int(cmdKey | shiftKey)]
        ], forKey: "shortcuts")
    }

    private func carbonKeyCode(for key: String) -> UInt32? {
        switch key.lowercased() {
        case "a": return UInt32(kVK_ANSI_A)
        case "s": return UInt32(kVK_ANSI_S)
        case "d": return UInt32(kVK_ANSI_D)
        case "f": return UInt32(kVK_ANSI_F)
        case "h": return UInt32(kVK_ANSI_H)
        case "g": return UInt32(kVK_ANSI_G)
        case "z": return UInt32(kVK_ANSI_Z)
        case "x": return UInt32(kVK_ANSI_X)
        case "c": return UInt32(kVK_ANSI_C)
        case "v": return UInt32(kVK_ANSI_V)
        case "b": return UInt32(kVK_ANSI_B)
        case "q": return UInt32(kVK_ANSI_Q)
        case "w": return UInt32(kVK_ANSI_W)
        case "e": return UInt32(kVK_ANSI_E)
        case "r": return UInt32(kVK_ANSI_R)
        case "y": return UInt32(kVK_ANSI_Y)
        case "t": return UInt32(kVK_ANSI_T)
        case "1": return UInt32(kVK_ANSI_1)
        case "2": return UInt32(kVK_ANSI_2)
        case "3": return UInt32(kVK_ANSI_3)
        case "4": return UInt32(kVK_ANSI_4)
        case "6": return UInt32(kVK_ANSI_6)
        case "5": return UInt32(kVK_ANSI_5)
        case "9": return UInt32(kVK_ANSI_9)
        case "7": return UInt32(kVK_ANSI_7)
        case "8": return UInt32(kVK_ANSI_8)
        case "0": return UInt32(kVK_ANSI_0)
        case "o": return UInt32(kVK_ANSI_O)
        case "i": return UInt32(kVK_ANSI_I)
        case "p": return UInt32(kVK_ANSI_P)
        case "l": return UInt32(kVK_ANSI_L)
        case "j": return UInt32(kVK_ANSI_J)
        case "k": return UInt32(kVK_ANSI_K)
        case "m": return UInt32(kVK_ANSI_M)
        case " ", "space": return UInt32(kVK_Space)
        case "[": return UInt32(kVK_ANSI_LeftBracket)
        case "]": return UInt32(kVK_ANSI_RightBracket)
        case "=", "+": return UInt32(kVK_ANSI_Equal)
        case "-", "_": return UInt32(kVK_ANSI_Minus)
        case ";", ":": return UInt32(kVK_ANSI_Semicolon)
        case "'", "\"": return UInt32(kVK_ANSI_Quote)
        case ",": return UInt32(kVK_ANSI_Comma)
        case ".": return UInt32(kVK_ANSI_Period)
        case "/", "?": return UInt32(kVK_ANSI_Slash)
        case "\\", "|": return UInt32(kVK_ANSI_Backslash)
        case "enter", "return": return UInt32(kVK_Return)
        case "escape", "esc": return UInt32(kVK_Escape)
        case "delete", "backspace": return UInt32(kVK_Delete)
        case "arrowleft": return UInt32(kVK_LeftArrow)
        case "arrowright": return UInt32(kVK_RightArrow)
        case "arrowup": return UInt32(kVK_UpArrow)
        case "arrowdown": return UInt32(kVK_DownArrow)
        default: return nil
        }
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
        let globalModifierMask = UInt32(cmdKey | controlKey | optionKey)
        for (name, id) in hotKeyNames {
            guard let item = stored[name] as? [String: Any] else { continue }
            let key = (item["key"] as? String ?? "").lowercased()
            let storedKeyCode = UInt32((item["keyCode"] as? Int) ?? 0)
            let keyCode = carbonKeyCode(for: key) ?? storedKeyCode
            let modifiers = UInt32((item["modifiers"] as? Int) ?? 0)
            guard keyCode > 0, modifiers & globalModifierMask != 0 else { continue }
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
                appendOverlayLog("hotkey ok \(name) key=\(key) code=\(keyCode) mods=\(modifiers)")
            } else {
                appendOverlayLog("hotkey fail \(name) key=\(key) code=\(keyCode) mods=\(modifiers) status=\(status)")
            }
        }
    }

    private func handleHotKey(_ id: UInt32) {
        let name = hotKeyNames.first(where: { $0.value == id })?.key
        switch name {
        case "toggleSubtitle":
            toggleSubtitlePanel()
        case "toggleSettings", "settings":
            toggleSettings()
        case let command?:
            runShortcutInOverlay(command)
        default:
            break
        }
    }

    private func runShortcutInOverlay(_ command: String) {
        let escaped = command.replacingOccurrences(of: "'", with: "\\'")
        webView?.evaluateJavaScript("if (typeof runShortcut === 'function') runShortcut('\(escaped)');", completionHandler: nil)
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
            let filtered = shortcuts.reduce(into: [String: Any]()) { result, pair in
                if hotKeyNames[pair.key] != nil, let value = pair.value as? [String: Any] {
                    result[pair.key] = [
                        "key": value["key"] as? String ?? "",
                        "keyCode": value["keyCode"] as? Int ?? 0,
                        "modifiers": value["modifiers"] as? Int ?? 0
                    ]
                }
            }
            let old = UserDefaults.standard.dictionary(forKey: "shortcuts") as NSDictionary?
            if old == filtered as NSDictionary { return }
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
