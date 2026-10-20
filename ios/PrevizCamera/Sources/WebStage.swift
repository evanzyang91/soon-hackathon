// The web renderer: a full-screen WKWebView on phone.html?pose=external. Native pushes each
// pose and every relay message in (PrevizCore/WebBridge.swift); the page posts `ready` / `cmd` /
// `log` back. Contract: ios/README.md, "Web side contract".
import PrevizCore
import SwiftUI
import WebKit
import os

private let log = Logger(subsystem: "dev.previz.camera", category: "web")

@MainActor
final class WebStage: NSObject, WKNavigationDelegate {
  let webView: WKWebView
  var onPageMessage: ((PageMessage) -> Void)?
  /// A load failed (message) or recovered (nil).
  var onProblem: ((String?) -> Void)?
  private(set) var info = DebugSnapshot.WebInfo()
  private let trust: DevTrust
  private var url: URL?
  private var poseInFlight = false
  private var queuedPose: PhonePose?
  private var retry: Task<Void, Never>?
  private var retryAttempt = 0

  init(trust: DevTrust) {
    self.trust = trust
    let content = WKUserContentController()
    content.addUserScript(
      WKUserScript(source: WebBridge.bootstrapScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let config = WKWebViewConfiguration()
    config.userContentController = content
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    webView = WKWebView(frame: .zero, configuration: config)
    super.init()
    content.add(ScriptHandler(stage: self), name: WebBridge.handlerName)
    webView.navigationDelegate = self
    webView.isOpaque = false
    webView.backgroundColor = .black
    webView.scrollView.isScrollEnabled = false
    webView.scrollView.bounces = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    #if DEBUG
      webView.isInspectable = true  // Safari → Develop → <iPhone> → phone.html
    #endif
  }

  var ready: Bool { info.ready }

  func load(_ url: URL) {
    self.url = url
    info.url = url.absoluteString
    info.ready = false
    webView.load(URLRequest(url: url))
  }

  func tearDown() {
    retry?.cancel()
    webView.stopLoading()
    webView.navigationDelegate = nil
    webView.configuration.userContentController.removeScriptMessageHandler(forName: WebBridge.handlerName)
  }

  /// Render this pose. At most one evaluation is in flight; a newer pose replaces a queued one,
  /// so a slow page always gets the latest pose rather than a backlog.
  func push(_ pose: PhonePose) {
    guard info.ready else { return }
    if poseInFlight {
      queuedPose = pose
      return
    }
    guard let script = try? WebBridge.poseScript(pose) else { return }
    poseInFlight = true
    info.posesPushed += 1
    webView.evaluateJavaScript(script) { [weak self] _, error in
      guard let self else { return }
      self.poseInFlight = false
      if let error { self.info.lastError = error.localizedDescription }
      if let next = self.queuedPose {
        self.queuedPose = nil
        self.push(next)
      }
    }
  }

  /// Forward one relay frame (peers / scene / cmd) to the page.
  func forward(relayText: String) {
    guard info.ready, let script = try? WebBridge.messageScript(relayText: relayText) else { return }
    evaluate(script)
  }

  func publish(_ snapshot: DebugSnapshot) {
    guard let script = try? WebBridge.debugScript(snapshot) else { return }
    evaluate(script)
  }

  private func evaluate(_ script: String) {
    webView.evaluateJavaScript(script) { [weak self] _, error in
      if let error { self?.info.lastError = error.localizedDescription }
    }
  }

  fileprivate func received(_ message: WKScriptMessage) {
    guard let msg = PageMessage.parse(message.body) else { return }
    if msg == .ready {
      info.ready = true
      retryAttempt = 0
      onProblem?(nil)
    }
    onPageMessage?(msg)
  }

  // MARK: - WKNavigationDelegate

  func webView(
    _ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let (disposition, credential) = trust.evaluate(challenge)
    completionHandler(disposition, credential)
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    info.ready = false
    poseInFlight = false
    queuedPose = nil
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    info.loads += 1
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    failed(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    failed(error)
  }

  /// The page's process died (WebGL + splats can run out of memory): reload it.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    info.processTerminations += 1
    info.ready = false
    log.error("web content process terminated; reloading")
    if let url { webView.load(URLRequest(url: url)) }
  }

  private func failed(_ error: Error) {
    let ns = error as NSError
    if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled { return }  // superseded load
    info.lastError = error.localizedDescription
    onProblem?("Scene view failed to load: \(error.localizedDescription)")
    log.error("page load failed: \(error.localizedDescription, privacy: .public)")
    retry?.cancel()
    let delay = Backoff.delay(attempt: retryAttempt + 2)  // 2 s, 4 s, then 5 s
    retryAttempt += 1
    retry = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled, let self, let url = self.url else { return }
      self.webView.load(URLRequest(url: url))
    }
  }
}

/// WKUserContentController retains its handlers strongly; this one holds the stage weakly.
private final class ScriptHandler: NSObject, WKScriptMessageHandler {
  private weak var stage: WebStage?

  init(stage: WebStage) {
    self.stage = stage
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated { stage?.received(message) }
  }
}

/// SwiftUI host for the stage's web view (the model owns the WebStage, so it survives updates).
struct WebStageView: UIViewRepresentable {
  let stage: WebStage

  func makeUIView(context: Context) -> WKWebView { stage.webView }
  func updateUIView(_ uiView: WKWebView, context: Context) {}
}
