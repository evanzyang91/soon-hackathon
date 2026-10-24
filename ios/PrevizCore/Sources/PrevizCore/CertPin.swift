// Trust for the laptop's self-signed development certificate (server/https.ts), by SHA-256 pin.
//
// Pairing (trust on first use): the app downloads https://<host>/cert.pem while accepting
// whatever certificate the TLS handshake presents, checks the PEM it received is that same
// certificate, shows the SHA-256 fingerprint for the user to confirm, then stores the pin under
// `host:port`. Afterwards every connection to that host (relay WebSocket, manifest fetch, the
// WKWebView's page and sub-resources) is accepted only when the presented leaf certificate's
// SHA-256 equals the pin. Hosts without a pin get the system's default evaluation, so a
// certificate from an installed private CA (mkcert) keeps working without any pin.
import CryptoKit
import Foundation

public enum CertPin {
  /// DER bytes of every `CERTIFICATE` block in a PEM file, in order.
  public static func derCertificates(fromPEM pem: String) -> [Data] {
    var out: [Data] = []
    var body: String?
    for line in pem.split(whereSeparator: \.isNewline) {
      let l = line.trimmingCharacters(in: .whitespaces)
      if l == "-----BEGIN CERTIFICATE-----" {
        body = ""
      } else if l == "-----END CERTIFICATE-----" {
        if let b = body, let der = Data(base64Encoded: b) { out.append(der) }
        body = nil
      } else if body != nil {
        body! += l
      }
    }
    return out
  }

  /// SHA-256 of DER bytes, lowercase hex (the stored pin).
  public static func sha256Hex(_ der: Data) -> String {
    SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
  }

  /// `AB:CD:…` (the format of `openssl x509 -noout -fingerprint -sha256`).
  public static func displayFingerprint(_ hex: String) -> String {
    var pairs: [String] = []
    var i = hex.startIndex
    while i < hex.endIndex {
      let j = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
      pairs.append(hex[i..<j].uppercased())
      i = j
    }
    return pairs.joined(separator: ":")
  }
}

public enum TrustDecision: Equatable, Sendable {
  /// Pinned and matching: accept this server trust.
  case pinnedMatch
  /// Pinned but a different certificate (new Wi-Fi → regenerated cert, or someone else).
  case mismatch
  /// No pin for this host: let the system decide (an installed CA, or fail).
  case noPin
}

/// Pins by `host:port` (the app persists `pins` in UserDefaults).
public struct PinStore: Sendable, Equatable {
  public var pins: [String: String]

  public init(pins: [String: String] = [:]) { self.pins = pins }

  public func pin(for hostPort: String) -> String? { pins[hostPort.lowercased()] }

  public mutating func setPin(_ sha256Hex: String, for hostPort: String) {
    pins[hostPort.lowercased()] = sha256Hex.lowercased()
  }

  public mutating func removePin(for hostPort: String) { pins[hostPort.lowercased()] = nil }

  /// Decide for the leaf certificate (DER) a server at `hostPort` presented.
  public func decide(leafDER: Data, hostPort: String) -> TrustDecision {
    guard let pin = pin(for: hostPort) else { return .noPin }
    return CertPin.sha256Hex(leafDER) == pin ? .pinnedMatch : .mismatch
  }
}

/// Outcome of fetching /cert.pem during pairing.
public enum PairingCheck: Equatable, Sendable {
  /// The PEM's first certificate is the one TLS presented: offer this fingerprint (hex).
  case matches(sha256Hex: String)
  /// The server presented one certificate over TLS and served another (proxy? stale file?).
  case differs
  /// The response held no certificate.
  case noCertificate
}

public func checkPairing(presentedLeafDER: Data, servedPEM: String) -> PairingCheck {
  guard let served = CertPin.derCertificates(fromPEM: servedPEM).first else { return .noCertificate }
  return served == presentedLeafDER ? .matches(sha256Hex: CertPin.sha256Hex(served)) : .differs
}
