// swift-tools-version:5.10
// PrevizCore: the pure-Swift half of the ARKit camera app (pose math, lens, relay protocol,
// join links, certificate pins, web bridge). No UIKit / ARKit, so it builds and tests on macOS
// with only the Command Line Tools: `swift test` in this directory.
import PackageDescription

let package = Package(
  name: "PrevizCore",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "PrevizCore", targets: ["PrevizCore"])],
  targets: [
    .target(name: "PrevizCore"),
    .testTarget(
      name: "PrevizCoreTests",
      dependencies: ["PrevizCore"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
