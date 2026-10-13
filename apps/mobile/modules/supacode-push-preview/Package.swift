// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "SupacodePushPreview",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [.library(name: "PushPreviewCore", targets: ["PushPreviewCore"])],
  targets: [
    .target(name: "PushPreviewCore"),
    .testTarget(name: "PushPreviewCoreTests", dependencies: ["PushPreviewCore"], resources: [.copy("vectors.json")])
  ]
)
