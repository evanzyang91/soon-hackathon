#!/usr/bin/env bash
# Typecheck the iOS app sources without Xcode.
#
# With only the Command Line Tools there is no iPhoneOS SDK, but the macOS SDK ships the Mac
# Catalyst ("iOSSupport") Swift interfaces for UIKit, ARKit, WebKit, SwiftUI and AVFoundation.
# Typechecking against `arm64-apple-ios17.0-macabi` checks every call we make against Apple's
# real declarations (names, argument labels, types, optionality, availability, actor isolation).
# Catalyst-only gaps would show up as "unavailable in Mac Catalyst" errors; the app avoids them.
#
# Once Xcode is installed this script builds the real thing instead:
#   xcodebuild … -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
#
# Usage: ios/scripts/typecheck-app.sh            (Swift 5 mode, as the Xcode project)
#        STRICT=1 ios/scripts/typecheck-app.sh   (also -strict-concurrency=complete)
set -euo pipefail
cd "$(dirname "$0")/.."

if xcodebuild -version >/dev/null 2>&1; then
  echo "Xcode found: building PrevizCamera for a generic iOS device (no signing)"
  exec xcodebuild -project PrevizCamera.xcodeproj -scheme PrevizCamera -configuration Debug \
    -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
fi

SDK="$(xcrun --show-sdk-path)"
IOS_SUPPORT="$SDK/System/iOSSupport"
if [[ ! -d "$IOS_SUPPORT/System/Library/Frameworks/ARKit.framework" ]]; then
  echo "error: $SDK has no Mac Catalyst ARKit interface; cannot typecheck the app" >&2
  exit 1
fi
TARGET=arm64-apple-ios17.0-macabi
OUT="${TMPDIR:-/tmp}/previz-typecheck"
mkdir -p "$OUT"
FLAGS=(-target "$TARGET" -sdk "$SDK"
  -Fsystem "$IOS_SUPPORT/System/Library/Frameworks"
  -I "$IOS_SUPPORT/usr/lib/swift" -L "$IOS_SUPPORT/usr/lib"
  -swift-version 5 -module-cache-path "$OUT/module-cache")
if [[ "${STRICT:-0}" == 1 ]]; then FLAGS+=(-strict-concurrency=complete); fi

echo "1/2 PrevizCore ($TARGET)"
xcrun swiftc "${FLAGS[@]}" -parse-as-library -module-name PrevizCore -emit-module \
  -emit-module-path "$OUT/PrevizCore.swiftmodule" PrevizCore/Sources/PrevizCore/*.swift

echo "2/2 PrevizCamera app sources ($TARGET)"
xcrun swiftc "${FLAGS[@]}" -typecheck -I "$OUT" -module-name PrevizCamera PrevizCamera/Sources/*.swift
echo "typecheck OK"
