import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = BBBridgeViewController()
        window?.makeKeyAndVisible()

        // Cold start via "Open in Blockbench Touch": copy before Capacitor delivers the URL.
        BBTouchInbox.importFiles(connectionOptions.urlContexts)
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        BBTouchInbox.importFiles(URLContexts)
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// Files opened from other apps (Files, Mail, AirDrop, …) may live outside the sandbox and are
/// only readable through a security-scoped URL. Copy them into Documents/Imported/<name> so the
/// web layer (touch/files.js, via @capacitor/filesystem) can read them; it maps the original URL
/// to that path. Files already inside our Documents folder are opened in place (not copied).
enum BBTouchInbox {
    static func importFiles(_ contexts: Set<UIOpenURLContext>) {
        for context in contexts where context.url.isFileURL {
            copyIntoDocuments(context.url)
        }
    }

    @discardableResult
    static func copyIntoDocuments(_ url: URL) -> URL? {
        let fm = FileManager.default
        guard let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        let docsPath = docs.resolvingSymlinksInPath().path
        if url.resolvingSymlinksInPath().path.hasPrefix(docsPath + "/") {
            return url
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let dir = docs.appendingPathComponent("Imported", isDirectory: true)
        let dest = dir.appendingPathComponent(url.lastPathComponent)
        var copied = false
        var coordError: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &coordError) { readURL in
            do {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                if fm.fileExists(atPath: dest.path) {
                    try fm.removeItem(at: dest)
                }
                try fm.copyItem(at: readURL, to: dest)
                copied = true
            } catch {
                NSLog("[BBTouch] could not import \(url.lastPathComponent): \(error)")
            }
        }
        if let coordError = coordError {
            NSLog("[BBTouch] file coordination failed for \(url.lastPathComponent): \(coordError)")
        }
        return copied ? dest : nil
    }
}

/// M7: Apple Pencil double-tap (Pencil 2 / Pro) → JS window event `bbtouchPencilTap`
/// (handled by touch/pencil.js: eraser toggle / previous tool / colour popover).
class BBBridgeViewController: CAPBridgeViewController, UIPencilInteractionDelegate {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        let interaction = UIPencilInteraction()
        interaction.delegate = self
        view.addInteraction(interaction)
    }

    private func sendPencilTap() {
        let action: String
        switch UIPencilInteraction.preferredTapAction {
        case .switchEraser: action = "switchEraser"
        case .switchPrevious: action = "switchPrevious"
        case .showColorPalette: action = "showColorPalette"
        case .ignore: action = "ignore"
        default: action = "other"
        }
        bridge?.triggerWindowJSEvent(eventName: "bbtouchPencilTap", data: "{\"action\":\"\(action)\"}")
    }

    // iOS 12.1 – 17.4 (still called on later versions when the new method is not implemented)
    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        sendPencilTap()
    }

    // M8: Apple Pencil Pro squeeze (iOS 17.5+) → same JS event with kind "squeeze" and the
    // user's system squeeze preference (palettes map to the colour popover in touch/pencil.js).
    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard squeeze.phase == .ended else { return }
        let action: String
        switch UIPencilInteraction.preferredSqueezeAction {
        case .switchEraser: action = "switchEraser"
        case .switchPrevious: action = "switchPrevious"
        case .showColorPalette: action = "showColorPalette"
        case .showInkAttributes: action = "showInkAttributes"
        case .showContextualPalette: action = "showContextualPalette"
        case .ignore, .runSystemShortcut: action = "ignore"
        default: action = "other"
        }
        bridge?.triggerWindowJSEvent(eventName: "bbtouchPencilTap", data: "{\"action\":\"\(action)\",\"kind\":\"squeeze\"}")
    }
}
