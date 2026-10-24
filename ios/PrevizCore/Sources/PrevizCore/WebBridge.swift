// Native ⇄ web page bridge for `phone.html?pose=external` (contract: ios/README.md, "Web side
// contract"). Native → page goes through `WKWebView.evaluateJavaScript` with the strings built
// here; page → native through `window.webkit.messageHandlers.previz.postMessage(obj)`.
import Foundation

public enum WebBridge {
  /// `window.__previzPose(pose: PhonePose)`: render this pose now (called once per ARFrame).
  public static let poseFunction = "__previzPose"
  /// `window.__previzMessage(msg: ServerMessage)`: a relay message (peers / scene / cmd).
  public static let messageFunction = "__previzMessage"
  /// `window.__previzNative`: the native debug snapshot (read-only for the page / inspector).
  public static let debugGlobal = "__previzNative"
  /// `window.webkit.messageHandlers.previz`.
  public static let handlerName = "previz"
  /// Bridge version the page can check (`window.__previzNativeHost.bridge`).
  public static let version = 1

  /// Injected at document start, before the page's own scripts run.
  public static var bootstrapScript: String {
    "window.__previzNativeHost=Object.freeze({platform:'ios',source:'arkit',bridge:\(version)});"
  }

  /// Script that hands one pose to the page. A missing function (page not ready yet) is a no-op;
  /// the trailing `0` keeps the result a plain number for evaluateJavaScript.
  public static func poseScript(_ pose: PhonePose) throws -> String {
    call(poseFunction, json: try Wire.encode(pose))
  }

  /// Script that forwards one relay frame. The text is parsed and re-serialised first, so only
  /// plain JSON (never arbitrary script) reaches the page.
  public static func messageScript(relayText: String) throws -> String {
    let obj = try JSONSerialization.jsonObject(with: Data(relayText.utf8))
    guard obj is [String: Any] else { throw BridgeError.notAnObject }
    let data = try JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])
    return call(messageFunction, json: String(decoding: data, as: UTF8.self))
  }

  /// Script that publishes the debug snapshot as `window.__previzNative`.
  public static func debugScript<T: Encodable>(_ snapshot: T) throws -> String {
    "window.\(debugGlobal)=\(try Wire.encode(snapshot));0"
  }

  private static func call(_ fn: String, json: String) -> String {
    "window.\(fn)&&window.\(fn)(\(json));0"
  }

  public enum BridgeError: Error { case notAnObject }
}

/// Messages the page posts to `window.webkit.messageHandlers.previz`.
public enum PageMessage: Equatable, Sendable {
  /// The bridge functions are installed: native replays the latest peers + scene.
  case ready
  /// Forward a command to the relay (only if the page shows its own buttons).
  case cmd(CommandName)
  /// Free-form log line (shown in the native debug overlay).
  case log(String)

  /// `body` is what WKScriptMessage.body delivers for a JS object: `[String: Any]`.
  public static func parse(_ body: Any) -> PageMessage? {
    guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return nil }
    switch type {
    case "ready": return .ready
    case "cmd":
      return (dict["cmd"] as? String).flatMap(CommandName.init(rawValue:)).map(PageMessage.cmd)
    case "log": return .log(String(describing: dict["message"] ?? ""))
    default: return nil
    }
  }
}
