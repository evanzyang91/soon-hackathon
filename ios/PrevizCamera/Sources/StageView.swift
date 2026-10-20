// Stage: the web renderer full screen, native controls on top. The page (pose=external) keeps
// its informational HUD (camera name, lens, clock, caption, perf) and hides its own controls;
// these native ones replace them (see ios/README.md "Web side contract").
import PrevizCore
import SwiftUI

struct StageView: View {
  @Bindable var model: AppModel
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      if let web = model.web {
        WebStageView(stage: web).ignoresSafeArea()
      }
      FlashView(trigger: model.flashCount)
      hud
      if model.showDebug { DebugOverlay(text: model.debugText) }
    }
    .statusBarHidden()
    .persistentSystemOverlays(.hidden)
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { model.foreground() }
    }
  }

  private var hud: some View {
    VStack(spacing: 0) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 6) {
          Button { model.showDebug.toggle() } label: {
            TrackingBadge(quality: model.tracking, interrupted: model.interrupted)
          }
          .accessibilityHint("Shows the debug state")
          ConnectionLabel(conn: model.conn, laptop: model.peers.laptop, room: model.target?.room ?? "")
          if let hint = model.interrupted ? "Camera in use elsewhere. Holding the last pose" : model.tracking.hint {
            Pill(text: hint)
          }
          if let banner = model.banner { Pill(text: banner, tint: .red) }
        }
        Spacer()
        Button(model.scenePlaying ? "CUT" : "ACTION") { model.action() }
          .buttonStyle(ClapperStyle(active: model.scenePlaying))
      }
      Spacer()
      HStack(alignment: .bottom) {
        Button { model.leave() } label: {
          Image(systemName: "xmark").font(.headline)
        }
        .buttonStyle(RoundStyle(size: 40))
        .accessibilityLabel("Leave")
        Spacer()
        if let toast = model.toast { Pill(text: toast) }
        Spacer()
      }
    }
    .padding(16)
    .overlay(alignment: .trailing) {
      VStack(spacing: 18) {
        Button("Recentre") { model.recentre() }
          .buttonStyle(CapsuleStyle())
        Button { model.shutter() } label: {
          Circle().fill(.white).frame(width: 58, height: 58)
        }
        .buttonStyle(RoundStyle(size: 72))
        .accessibilityLabel("Shutter")
        Button { model.toggleRecord() } label: {
          RoundedRectangle(cornerRadius: model.recording ? 5 : 20)
            .fill(.red)
            .frame(width: model.recording ? 24 : 40, height: model.recording ? 24 : 40)
        }
        .buttonStyle(RoundStyle(size: 56))
        .accessibilityLabel(model.recording ? "Stop recording" : "Record")
      }
      .padding(.trailing, 16)
    }
  }
}

private struct TrackingBadge: View {
  let quality: TrackingQuality
  let interrupted: Bool

  var body: some View {
    let (text, color): (String, Color) =
      interrupted
      ? ("Interrupted", .red)
      : (quality.label, quality.isGood ? .green : quality == .notAvailable ? .red : .orange)
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: 8, height: 8)
      Text("ARKit · \(text)").font(.caption.weight(.semibold))
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(.black.opacity(0.55), in: Capsule())
    .foregroundStyle(.white)
  }
}

private struct ConnectionLabel: View {
  let conn: RelayConnection.State
  let laptop: Bool
  let room: String

  var body: some View {
    let state =
      switch conn {
      case .open: laptop ? "director connected" : "waiting for director"
      case .connecting: "connecting…"
      case .reconnecting: "reconnecting…"
      case .idle, .closed: "offline"
      }
    Pill(text: "\(room) · \(state)", tint: conn == .open && laptop ? .clear : .orange)
  }
}

private struct Pill: View {
  let text: String
  var tint: Color = .clear

  var body: some View {
    Text(text)
      .font(.caption)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background(.black.opacity(0.55), in: Capsule())
      .overlay(Capsule().stroke(tint.opacity(0.8), lineWidth: 1))
      .foregroundStyle(.white)
  }
}

private struct FlashView: View {
  let trigger: Int
  @State private var opacity = 0.0

  var body: some View {
    Color.white.opacity(opacity).ignoresSafeArea().allowsHitTesting(false)
      .onChange(of: trigger) {
        opacity = 0.8
        withAnimation(.easeOut(duration: 0.35)) { opacity = 0 }
      }
  }
}

private struct DebugOverlay: View {
  let text: String

  var body: some View {
    ScrollView {
      Text(text)
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(.green)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .padding(12)
    }
    .frame(maxWidth: 420, maxHeight: 320)
    .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 10))
    .padding(.top, 90)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .padding(16)
  }
}

private struct RoundStyle: ButtonStyle {
  let size: CGFloat

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .frame(width: size, height: size)
      .background(.black.opacity(configuration.isPressed ? 0.7 : 0.45), in: Circle())
      .overlay(Circle().stroke(.white.opacity(0.85), lineWidth: 3))
      .foregroundStyle(.white)
  }
}

private struct CapsuleStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.caption.weight(.semibold))
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(.black.opacity(configuration.isPressed ? 0.7 : 0.5), in: Capsule())
      .foregroundStyle(.white)
  }
}

private struct ClapperStyle: ButtonStyle {
  let active: Bool

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.subheadline.weight(.heavy))
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      .background(
        (active ? Color.red : Color.black).opacity(configuration.isPressed ? 0.8 : 0.6),
        in: RoundedRectangle(cornerRadius: 8)
      )
      .foregroundStyle(.white)
  }
}
