// Trust for the laptop's self-signed dev certificate: SHA-256 pins (PrevizCore/CertPin.swift)
// applied to every TLS connection the app makes: the relay WebSocket and manifest fetches
// (URLSession delegates below) and the WKWebView (WebStage's navigation delegate).
//
// Why pins rather than ATS keys: ATS exceptions never make a self-signed certificate pass
// trust evaluation; they only allow the app to override it. Info.plist sets
// NSAllowsLocalNetworking (required anyway on iOS 17+ to reach a LAN IP address), and this
// file does the override for exactly one certificate per host:port, the one the user confirmed
// when pairing. Hosts without a pin get the system's default evaluation, so a certificate from a
// private CA installed on the phone (mkcert) works with no pin at all.
import Foundation
import PrevizCore
import Security
import os

private let log = Logger(subsystem: "dev.previz.camera", category: "trust")

@MainActor
final class DevTrust {
  private let defaults: UserDefaults
  private let key = "previz.certPins"
  private(set) var store: PinStore
  /// host:port whose presented certificate did not match its pin (most recent).
  private(set) var lastMismatch: String?

  /// Data fetches (manifests) that honour the pins. Delegate callbacks on the main queue.
  private(set) lazy var dataSession: URLSession = URLSession(
    configuration: .default, delegate: PinningSessionDelegate(trust: self), delegateQueue: .main)

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    store = PinStore(pins: defaults.dictionary(forKey: key) as? [String: String] ?? [:])
  }

  func setPin(_ sha256Hex: String, for hostPort: String) {
    store.setPin(sha256Hex, for: hostPort)
    if lastMismatch == hostPort.lowercased() { lastMismatch = nil }
    defaults.set(store.pins, forKey: key)
    log.info("pinned \(hostPort, privacy: .public)")
  }

  func removePin(for hostPort: String) {
    store.removePin(for: hostPort)
    defaults.set(store.pins, forKey: key)
  }

  /// What the join screen should do for `target`.
  enum Preparation: Equatable {
    /// Connect: the system trusts the certificate, or it matches the pin.
    case ready(trust: String)
    /// Ask the user to confirm this fingerprint (`changed` = a different pin existed).
    case confirm(sha256Hex: String, changed: Bool)
  }

  /// Probe the server's certificate (trust on first use) and decide.
  func prepare(_ target: JoinTarget) async throws -> Preparation {
    let probe = try await CertificateProbe.run(target)
    if probe.systemTrusted { return .ready(trust: "system") }
    switch checkPairing(presentedLeafDER: probe.leafDER, servedPEM: probe.servedPEM) {
    case .matches(let hex):
      let pinned = store.pin(for: target.hostPort)
      if pinned == hex { return .ready(trust: "pinned") }
      return .confirm(sha256Hex: hex, changed: pinned != nil)
    case .differs:
      throw TrustError.servedCertificateDiffers
    case .noCertificate:
      throw TrustError.noCertificate
    }
  }

  /// Server-trust decision for a challenge (URLSession or WKWebView). Main actor.
  func evaluate(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
    let space = challenge.protectionSpace
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let serverTrust = space.serverTrust
    else { return (.performDefaultHandling, nil) }
    let hostPort = Self.hostPort(space)
    guard let der = Self.leafDER(serverTrust) else { return (.cancelAuthenticationChallenge, nil) }
    switch store.decide(leafDER: der, hostPort: hostPort) {
    case .pinnedMatch:
      // The exact certificate the user confirmed when pairing (compared byte for byte by hash).
      return (.useCredential, URLCredential(trust: serverTrust))
    case .mismatch:
      lastMismatch = hostPort
      log.error("certificate for \(hostPort, privacy: .public) does not match its pin")
      return (.performDefaultHandling, nil)  // a CA-signed / installed-CA cert still passes
    case .noPin:
      return (.performDefaultHandling, nil)
    }
  }

  nonisolated static func hostPort(_ space: URLProtectionSpace) -> String {
    var host = space.host
    if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
    let port = space.port > 0 ? space.port : 443
    return JoinTarget(host: host, port: port, room: "").hostPort.lowercased()
  }

  nonisolated static func leafDER(_ trust: SecTrust) -> Data? {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first
    else { return nil }
    return SecCertificateCopyData(leaf) as Data
  }

  enum TrustError: LocalizedError {
    case servedCertificateDiffers
    case noCertificate

    var errorDescription: String? {
      switch self {
      case .servedCertificateDiffers:
        "The server presented one certificate and served a different /cert.pem. Not pairing."
      case .noCertificate: "/cert.pem did not contain a certificate. Is this the Previz server?"
      }
    }
  }
}

/// URLSession delegate that applies DevTrust's pins. Its session's delegate queue must be main,
/// which is the only place `trust` is read (hence the unchecked Sendable).
final class PinningSessionDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
  private weak var trust: DevTrust?

  @MainActor init(trust: DevTrust) {
    self.trust = trust
  }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let decision = MainActor.assumeIsolated {
      trust?.evaluate(challenge) ?? (.performDefaultHandling, nil)
    }
    completionHandler(decision.0, decision.1)
  }
}

/// One-off download of /cert.pem that accepts whatever certificate the TLS handshake presents
/// and records it, so the app can compare the two and show the fingerprint. Nothing from this
/// connection is trusted except for that comparison.
enum CertificateProbe {
  struct Result {
    var leafDER: Data
    var servedPEM: String
    /// The system already trusts this certificate (installed private CA): no pin needed.
    var systemTrusted: Bool
  }

  static func run(_ target: JoinTarget) async throws -> Result {
    let delegate = ProbeDelegate()
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 6
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: config, delegate: delegate, delegateQueue: queue)
    defer { session.finishTasksAndInvalidate() }
    let (data, response) = try await session.data(from: target.certificateURL)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    guard let seen = delegate.seen else { throw URLError(.secureConnectionFailed) }
    return Result(
      leafDER: seen.der, servedPEM: String(decoding: data, as: UTF8.self), systemTrusted: seen.systemTrusted)
  }

  /// Runs on the probe's private serial queue (SecTrustEvaluateWithError may block).
  private final class ProbeDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var _seen: (der: Data, systemTrusted: Bool)?

    var seen: (der: Data, systemTrusted: Bool)? { lock.withLock { _seen } }

    func urlSession(
      _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
      completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
      guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
        let serverTrust = challenge.protectionSpace.serverTrust,
        let der = DevTrust.leafDER(serverTrust)
      else {
        completionHandler(.performDefaultHandling, nil)
        return
      }
      let systemTrusted = SecTrustEvaluateWithError(serverTrust, nil)
      lock.withLock { _seen = (der, systemTrusted) }
      completionHandler(.useCredential, URLCredential(trust: serverTrust))
    }
  }
}
