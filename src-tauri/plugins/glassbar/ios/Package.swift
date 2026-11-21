// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-glassbar",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "tauri-plugin-glassbar", type: .static, targets: ["tauri-plugin-glassbar"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(name: "tauri-plugin-glassbar", dependencies: [.byName(name: "Tauri")], path: "Sources"),
    ]
)
