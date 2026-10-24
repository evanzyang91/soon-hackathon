// The relay socket (wss://<host>/ws) over URLSessionWebSocketTask: Hello on every (re)connect,
// reconnect with backoff (0.5 s → 5 s, as web/src/phone/relay-client.ts), ping-based dead-link
// detection, and a stall guard (iOS can keep a socket "open" after a Wi-Fi hiccup).
import Foundation
import PrevizCore
import os

private let log = Logger(subsystem: "dev.previz.camera", category: "relay")

@MainActor
final class RelayConnection {
  enum State: String {
    case idle, connecting, open, reconnecting, closed
  }

  private(set) var state: State = .idle {
    didSet { if state != oldValue { onState?(state) } }
  }
  var onState: ((State) -> Void)?
  /// Every text frame from the relay.
  var onText: ((String) -> Void)?
  /// A connection attempt failed (message for the HUD).
  var onError: ((String) -> Void)?

  private let target: JoinTarget
  private let trust: DevTrust
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var attempt = 0
  private var stopped = true
  private var reconnect: Task<Void, Never>?
  private var pinger: Timer?
  private var lastPongAt = Date()
  /// Sends whose completion has not come back yet.
  private var inFlight = 0
  /// About 2 s of poses at 30 Hz.
  private let maxInFlight = 60

  init(target: JoinTarget, trust: DevTrust) {
    self.target = target
    self.trust = trust
  }

  func start() {
    guard stopped else { return }
    stopped = false
    session = URLSession(
      configuration: .default, delegate: SocketDelegate(owner: self, trust: trust), delegateQueue: .main)
    open()
  }

  func stop() {
    stopped = true
    reconnect?.cancel()
    reconnect = nil
    pinger?.invalidate()
    pinger = nil
    task?.cancel(with: .normalClosure, reason: nil)
    task = nil
    session?.invalidateAndCancel()  // also releases the delegate
    session = nil
    state = .closed
  }

  /// Back in the foreground: reconnect at once instead of waiting out the backoff.
  func reconnectNow() {
    guard !stopped, state != .open, state != .connecting else { return }
    reconnect?.cancel()
    attempt = 0
    open()
  }

  /// Send one text frame. False when not connected (the caller just drops the pose).
  @discardableResult
  func send(_ text: String) -> Bool {
    guard state == .open, let task else { return false }
    if inFlight > maxInFlight {
      log.warning("socket stalled (\(self.inFlight) sends pending); reconnecting")
      dropped(task)
      return false
    }
    inFlight += 1
    task.send(.string(text)) { [weak self] error in
      Task { @MainActor in
        guard let self, self.task === task else { return }
        self.inFlight = max(0, self.inFlight - 1)
        if let error { log.debug("send failed: \(error.localizedDescription, privacy: .public)") }
      }
    }
    return true
  }

  func send<T: Encodable>(_ message: T) {
    if let text = try? Wire.encode(message) { send(text) }
  }

  // MARK: - lifecycle

  private func open() {
    guard !stopped, let session else { return }
    state = attempt == 0 ? .connecting : .reconnecting
    let t = session.webSocketTask(with: target.webSocketURL)
    task = t
    inFlight = 0
    t.resume()
    receive(t)
  }

  private func receive(_ t: URLSessionWebSocketTask) {
    Task { @MainActor [weak self] in
      while true {
        let message: URLSessionWebSocketTask.Message
        do {
          message = try await t.receive()
        } catch {
          self?.dropped(t)
          return
        }
        guard let self, self.task === t else { return }
        switch message {
        case .string(let text): self.onText?(text)
        case .data: log.debug("ignored a binary frame")
        @unknown default: break
        }
      }
    }
  }

  fileprivate func didOpen(_ t: URLSessionWebSocketTask) {
    guard t === task else { return }
    attempt = 0
    lastPongAt = Date()
    state = .open
    send(Hello(room: target.room))
    pinger?.invalidate()
    pinger = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.ping() }
    }
  }

  fileprivate func didFail(_ t: URLSessionTask, error: Error?) {
    if let error, !stopped {
      let ns = error as NSError
      var why = error.localizedDescription
      if trust.lastMismatch == target.hostPort.lowercased() {
        why = "The laptop's certificate changed (new network?). Leave and join again to re-pair."
      } else if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorServerCertificateUntrusted {
        why = "The laptop's certificate is not trusted. Leave and join again to pair."
      }
      onError?(why)
    }
    if let ws = t as? URLSessionWebSocketTask { dropped(ws) }
  }

  private func ping() {
    guard state == .open, let t = task else { return }
    if Date().timeIntervalSince(lastPongAt) > 12 {
      log.warning("no pong for 12 s; reconnecting")
      dropped(t)
      return
    }
    t.sendPing { [weak self] error in
      Task { @MainActor in
        if error == nil, let self, self.task === t { self.lastPongAt = Date() }
      }
    }
  }

  /// The current socket is gone (closed, failed, stalled): schedule the next attempt.
  private func dropped(_ t: URLSessionWebSocketTask) {
    guard t === task else { return }
    task = nil
    t.cancel(with: .goingAway, reason: nil)
    pinger?.invalidate()
    pinger = nil
    guard !stopped else { return }
    state = .reconnecting
    let delay = Backoff.delay(attempt: attempt)
    attempt += 1
    reconnect?.cancel()
    reconnect = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      self?.open()
    }
  }
}

/// Session delegate (main queue): socket lifecycle + DevTrust pins. Holds the owner weakly so
/// URLSession's strong reference to its delegate cannot keep the connection alive. Only touched
/// on the main queue (the session's delegate queue), hence the unchecked Sendable.
private final class SocketDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  private weak var owner: RelayConnection?
  private weak var trust: DevTrust?

  @MainActor init(owner: RelayConnection, trust: DevTrust) {
    self.owner = owner
    self.trust = trust
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?
  ) {
    MainActor.assumeIsolated { owner?.didOpen(webSocketTask) }
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    MainActor.assumeIsolated { owner?.didFail(webSocketTask, error: nil) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    MainActor.assumeIsolated { owner?.didFail(task, error: error) }
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
