// Where to join: host (+ port) and room code, from the laptop's QR / phone URL or typed input.
//
// The laptop's QR encodes `https://<lan-ip>:5173/phone.html?room=ABCD` (server/index.ts
// /api/rooms/new). Users may also type `192.168.1.20:5173`, `192.168.1.20`, or
// `evans-mbp.local`. The server is HTTPS-only, so the scheme is always https / wss.
import Foundation

public struct JoinTarget: Sendable, Equatable, Codable {
  /// Host name or IP literal (IPv6 without brackets).
  public var host: String
  public var port: Int
  public var room: String

  public static let defaultPort = 5173

  public init(host: String, port: Int = JoinTarget.defaultPort, room: String) {
    self.host = host
    self.port = port
    self.room = room
  }

  /// `host:port` as typed and as the pin store keys it (IPv6 in brackets).
  public var hostPort: String { "\(host.contains(":") ? "[\(host)]" : host):\(port)" }

  public var baseURL: URL { url(scheme: "https", path: "/") }
  /// The relay socket.
  public var webSocketURL: URL { url(scheme: "wss", path: "/ws") }
  /// The dev certificate, served by server/index.ts for exactly this purpose.
  public var certificateURL: URL { url(scheme: "https", path: "/cert.pem") }

  /// The web phone page in external-pose mode (see ios/README.md "Web side contract").
  public func pageURL(voice: Bool = false) -> URL {
    url(scheme: "https", path: "/phone.html", query: [
      URLQueryItem(name: "room", value: room),
      URLQueryItem(name: "pose", value: "external"),
      URLQueryItem(name: "voice", value: voice ? "1" : "0"),
      URLQueryItem(name: "sim", value: "0"),
    ])
  }

  /// Resolve a (possibly relative) URL from the relay, e.g. `SceneState.manifestUrl`.
  public func resolve(_ reference: String) -> URL? {
    URL(string: reference, relativeTo: baseURL)?.absoluteURL
  }

  private func url(scheme: String, path: String, query: [URLQueryItem]? = nil) -> URL {
    var c = URLComponents()
    c.scheme = scheme
    if host.contains(":") {
      c.percentEncodedHost = "[\(host)]"  // IPv6 literal: URLComponents wants the brackets
    } else {
      c.host = host
    }
    c.port = port
    c.path = path
    c.queryItems = query
    // Hosts come from parseHost (a URL that already parsed), so this only fails on a
    // hand-built target; fall back to a URL that fails to connect instead of crashing.
    return c.url ?? URL(string: "\(scheme)://invalid.invalid\(path)")!
  }
}

public enum JoinLink {
  /// `ABCD` from ` abcd ` (4–6 of A–Z / 0–9, as server/relay-rooms.ts `normalizeRoom`).
  public static func normalizeRoom(_ code: String) -> String? {
    let c = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    guard (4...6).contains(c.count), c.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
    else { return nil }
    return c
  }

  /// Host and port from a URL or `host[:port]` (default port 5173). Nil when there is no host.
  public static func parseHost(_ input: String) -> (host: String, port: Int)? {
    let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return nil }
    let withScheme = s.contains("://") ? s : "https://\(s)"
    guard let c = URLComponents(string: withScheme), var host = c.host, !host.isEmpty else {
      return nil
    }
    if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
    let port = c.port ?? JoinTarget.defaultPort
    guard (1...65535).contains(port) else { return nil }
    return (host.lowercased(), port)
  }

  /// A full target from a scanned QR / pasted phone URL (needs `?room=`).
  public static func parse(_ text: String) -> JoinTarget? {
    let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let c = URLComponents(string: s), c.scheme != nil,
      let room = c.queryItems?.first(where: { $0.name == "room" })?.value.flatMap(normalizeRoom),
      let hp = parseHost(s)
    else { return nil }
    return JoinTarget(host: hp.host, port: hp.port, room: room)
  }

  /// A target from the two text fields of the join screen.
  public static func target(host: String, room: String) -> JoinTarget? {
    // A pasted phone URL in the host field carries its own room.
    if let full = parse(host) { return full }
    guard let hp = parseHost(host), let r = normalizeRoom(room) else { return nil }
    return JoinTarget(host: hp.host, port: hp.port, room: r)
  }
}
