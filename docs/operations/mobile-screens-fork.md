# Mobile Screens dependency

The mobile client pins `react-native-screens` to the committed
`apps/mobile/deps/react-native-screens-5.0.0-supacode.24.tgz` archive. Its runtime,
declarations and native sources come from
[source commit f16e7a93](https://github.com/juliusmarminge/react-native-screens/commit/f16e7a93f84e00f2c93fd7875012cde6457ef578),
based on `eaf8d118f77976a7978581bf94a5fe199bb0a64a`. Supacode changes the package
version and archive metadata; it preserves the runtime and native source.
`supacode-fork.json` inside the archive records that provenance.

Compiled JavaScript, declarations and native source must come from the same
revision. Replacing only one part can leave the navigation API out of step with
its native implementation. Keep source provenance with each replacement archive
and update the dependency and lockfile together.

The fingerprint includes native dependency files and applied native patches.
A change to either requires a matching native client before the new bundle can
run. See [native client verification](../../.agents/skills/test-supacode-mobile/SKILL.md).

The same iOS binary supports iPhone, iPad, and Duo. UIKit hinge updates enable
phone workspace columns at runtime; regular phones retain portrait rotation.
Duo support requires a binary built with the iOS 27.1 SDK, so every iOS EAS
profile pins the `macos-tahoe-26.6-xcode-27.1` image; an OTA cannot add the
native APIs.
