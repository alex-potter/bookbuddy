# Android APK auto-updates

**Status:** Design approved, ready for implementation plan
**Date:** 2026-05-08

## Problem

BookBuddy's Android APK is distributed via GitHub Releases (sideload). The current `android/app/build.gradle` has hard-coded `versionCode 1` / `versionName "1.0"` that has never been bumped, even though the project has shipped releases v0.0.16 through v0.0.21. The README tells users to "check the Releases page periodically." There is no in-app mechanism to detect or apply updates.

We want users to find out when a new APK is available without leaving the app, and install it with a single tap.

## Constraints

- Distribution stays on GitHub Releases — we are not publishing to the Play Store.
- No background work: the check runs only when the app is open.
- No third-party update libraries; the existing custom plugin pattern (`LlamaPlugin.kt`) is the precedent.
- Web/PWA build paths must be unaffected.
- A fresh signing keystore is acceptable; existing v0.0.21 users will need to uninstall and reinstall once. After that, all future updates install over the top normally.

## Decisions

| # | Decision |
|---|----------|
| 1 | **Update UX:** Notify + one-tap install. App detects update, shows banner, downloads APK on tap, hands off to Android's `PackageInstaller` via `Intent.ACTION_VIEW`. |
| 2 | **Check timing:** On app launch (with 6h cache) plus a manual "Check now" button in Settings. No background work. |
| 3 | **Versioning:** Single source of truth in `package.json`. A build script writes `version` into `android/app/build.gradle` as `versionName` and derives `versionCode` deterministically. |
| 4 | **Release pipeline:** Tag-triggered GitHub Actions workflow builds the signed APK and attaches it to the release. |
| 5 | **Signing:** Generate a new release keystore. Store it in GitHub secrets, document the one-time uninstall requirement in the v0.0.22 release notes. |

## Architecture

Five components, each independently testable.

### 1. Version sync script — `scripts/sync-android-version.js`

Reads `version` from `package.json`, opens `android/app/build.gradle`, and replaces the `versionName` and `versionCode` lines.

- `versionName` = exact string from `package.json` (e.g. `"0.0.22"`).
- `versionCode` = `major * 10000 + minor * 100 + patch` (e.g. `0.0.22` → `22`, `1.2.3` → `10203`). Monotonic as long as no field exceeds 99 — fine for this project.
- Idempotent: safe to run repeatedly. Throws if the gradle file's pattern can't be matched (defensive, prevents silent drift).

Wired into `scripts/mobile-build.js` so every Capacitor build syncs the version before `npx cap sync`. Local devs and CI both benefit.

### 2. Release workflow — `.github/workflows/release.yml`

Trigger: `push` of any tag matching `v*`.

Steps:
1. Checkout, set up Node 20 + JDK 17 + Android SDK, npm submodules (llama.cpp).
2. `npm ci`, `npm run build:capacitor` (which now runs `sync-android-version.js`).
3. Decode base64 keystore from `secrets.ANDROID_KEYSTORE_BASE64` to a temp file.
4. `cd android && ./gradlew assembleRelease` with signing config sourced from `secrets.ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
5. Upload `android/app/build/outputs/apk/release/app-release.apk` as a release asset using `softprops/action-gh-release@v2`.

The release itself can be created manually (`gh release create v0.0.22 --notes "..."`) — the workflow attaches the APK to whatever release matches the tag.

### 3. Update-check client — `lib/update-check.ts`

Pure TypeScript module, no Capacitor dependency. Public API:

```ts
type UpdateStatus =
  | { available: true; latestVersion: string; apkUrl: string; releaseNotes: string; checkedAt: number }
  | { available: false; checkedAt: number };

export async function checkForUpdate(opts?: { force?: boolean }): Promise<UpdateStatus>;
export function getLastChecked(): number | null;
```

Behaviour:
- Short-circuits on web: `if (!Capacitor.isNativePlatform()) return { available: false, checkedAt: Date.now() }`.
- Reads cache from `localStorage['updateCheck.cache']`. Returns it unchanged if `Date.now() - checkedAt < 6h` and `!force`.
- Fetches `https://api.github.com/repos/alex-potter/bookbuddy/releases/latest` with `Accept: application/vnd.github+json`.
- Filters out `prerelease: true` and releases without an `app-release.apk` asset (treat as no update).
- Parses `tag_name` by stripping a leading `v`. Compares against the running app's version from `App.getInfo()` using a small `compareSemver(a, b)` helper.
- On success, caches with full 6h TTL. On error (network, 403, malformed), caches `{ available: false }` with a 30-minute TTL so we don't hammer the API.

### 4. Native updater plugin — `UpdaterPlugin.kt` + `lib/updater-client.ts`

Capacitor plugin matching the pattern of the existing `LlamaPlugin`. Two methods:

- `download({ url: string }) → { path: string }`
  Streams the APK from `url` into `cacheDir/bookbuddy-update.apk` using OkHttp (already on classpath). Emits `progress` events with `{ percent: number }` roughly every 256 KB. Cancellable: a second `download` call or an explicit `cancel()` aborts the in-flight request and deletes the partial file.

- `install({ path: string }) → void`
  Builds a `content://` URI via FileProvider (authority `com.chaptercompanion.app.fileprovider`, configured against `cacheDir`) and starts an `Intent.ACTION_VIEW` with type `application/vnd.android.package-archive` and flags `FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK`. Android's system installer handles the rest, including the `REQUEST_INSTALL_PACKAGES` permission flow.

TS facade `lib/updater-client.ts` wraps this with typed methods and exposes a `progress$` observable (or async iterator) for the UI.

### 5. UI — banner + settings row

- **`components/UpdateBanner.tsx`** — small dismissible bar at the top of the app shell. States: `hidden`, `available(version, notes)`, `downloading(percent)`, `ready`, `installing`, `error(message)`. Tap "Install" → `download` → `install`. "Dismiss" hides for the current process only.
- **`components/Settings/UpdateRow.tsx`** — settings page entry showing current version (`App.getInfo().version`), last checked timestamp, and a "Check now" button that calls `checkForUpdate({ force: true })`.
- Mounted in the existing app shell layout. Both components are no-ops on web.

## Data flow

### App launch (native)
1. Root layout effect calls `checkForUpdate()`.
2. Module returns cached result if fresh, otherwise hits GitHub API.
3. If `available: true`, banner becomes visible.

### Install tap
1. UI calls `Updater.download(apkUrl)`. Banner shows progress.
2. On completion, UI calls `Updater.install(path)`.
3. Android system installer dialog appears. User confirms. App is replaced and restarts.

### Manual check (Settings)
1. User taps "Check now" → `checkForUpdate({ force: true })`.
2. Last-checked timestamp updates. Banner state mirrors the result.

## File layout

```
scripts/
  sync-android-version.js          # NEW
  mobile-build.js                  # MODIFIED — invoke sync before build

android/app/
  build.gradle                     # MODIFIED — signingConfigs.release; versionName/Code now written by sync script
  src/main/AndroidManifest.xml     # MODIFIED — REQUEST_INSTALL_PACKAGES, FileProvider declaration
  src/main/res/xml/file_paths.xml  # NEW — exposes cacheDir to FileProvider
  src/main/java/com/chaptercompanion/app/UpdaterPlugin.kt   # NEW
  src/main/java/com/chaptercompanion/app/MainActivity.kt    # MODIFIED — registerPlugin(UpdaterPlugin::class.java)

lib/
  update-check.ts                  # NEW
  updater-client.ts                # NEW

components/
  UpdateBanner.tsx                 # NEW
  Settings/UpdateRow.tsx           # NEW

app/
  layout.tsx (or AppShell entry)   # MODIFIED — mount banner, run launch check

.github/workflows/
  release.yml                      # NEW

package.json                       # MODIFIED — add @capacitor/app if missing; bump version per release
```

## Permissions & manifest changes

```xml
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />

<provider
    android:name="androidx.core.content.FileProvider"
    android:authorities="com.chaptercompanion.app.fileprovider"
    android:exported="false"
    android:grantUriPermissions="true">
  <meta-data
      android:name="android.support.FILE_PROVIDER_PATHS"
      android:resource="@xml/file_paths" />
</provider>
```

`res/xml/file_paths.xml`:

```xml
<paths>
  <cache-path name="updates" path="." />
</paths>
```

## Error handling

| Scenario | Handling |
|---|---|
| Offline / fetch error | Cache `{ available: false }` for 30 min. No banner. Console log only. |
| GitHub 403 rate limit | Same as offline. 6h cache means ~4 req/day per device — well under 60/h unauth limit. |
| Release missing `app-release.apk` | Treated as no update. |
| `tag_name` not `vX.Y.Z` | Skipped, logged. |
| Running version newer than latest (dev builds) | No banner. |
| Download IOException / disk full | Banner shows "Download failed — Retry." Partial file deleted. |
| User cancels download | Banner returns to `available` state. |
| Signature mismatch on first auto-update from old keystore | Android's system installer shows its own "App not installed" error — out of our process, we cannot detect it. v0.0.22 release notes and the README call out the one-time uninstall requirement up front. |
| `REQUEST_INSTALL_PACKAGES` denied | Android 8+ surfaces a settings deep-link automatically. No extra handling. |

## Testing (manual)

There are no automated tests in this repo. Verification steps for the implementer:

1. **Happy path.** Build and install a v0.0.22 APK locally. Publish a v0.0.23 release with a signed APK from the new workflow. Reopen the app → banner appears → tap Install → app updates → restarted app reports v0.0.23.
2. **Manual check while offline.** Toggle airplane mode, open Settings → Check now. Expect a non-crashing error state.
3. **Web build.** Run `npm run dev` in a browser. Banner must never render and `update-check.ts` must short-circuit before any network call.
4. **Pre-release filter.** Tag `v0.0.24-beta` and publish as a prerelease. Banner must stay hidden.
5. **Cache behaviour.** Open the app twice within 6h. The second open must not hit the GitHub API (verify in devtools / logcat).
6. **Cancel download.** Start install on a slow connection, tap Cancel. The partial file in `cacheDir` must be gone.

## Out of scope

- Background update checks via WorkManager or push notifications.
- Silent download before the user taps Install.
- Per-version dismissal of the banner ("don't show me v0.0.22 again").
- iOS auto-updates (no iOS distribution exists).
- Migrating to the Play Store.
- Delta / patch updates (full APK each time).

## Open questions

None — all major decisions resolved during brainstorming.
