// Previz Camera: the ARKit handheld camera for Previz Stage (prototype). See ios/README.md.
import SwiftUI

@main
struct PrevizCameraApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      switch model.phase {
      case .join: JoinView(model: model)
      case .stage: StageView(model: model)
      }
    }
  }
}
