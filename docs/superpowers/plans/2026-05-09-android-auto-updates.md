# Android APK Auto-Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a new BookBuddy APK is published to GitHub Releases, the running Android app detects it on launch, shows a banner, and installs the new version with one tap.

**Architecture:** Five small components — a version-sync script that keeps `package.json` and `android/app/build.gradle` aligned; a tag-triggered GitHub Actions workflow that builds and signs the APK; a TS module that polls the GitHub Releases API with a 6-hour cache; a custom Capacitor Kotlin plugin that downloads the APK and hands off to Android's PackageInstaller; and a banner + Settings row that surface all of this to the user. Web/PWA paths are short-circuited.

**Tech Stack:** Next.js 14 (App Router), Capacitor 6 + Kotlin, GitHub Actions, Gradle, Java/Kotlin Android.

**Spec:** `docs/superpowers/specs/2026-05-08-android-auto-updates-design.md` (commit `dad3aa0`).

**Note on tests:** This repo has no automated test suite (per CLAUDE.md). Each task ends with a manual verification step instead of running a test runner. The full end-to-end manual test plan is Task 16.

---

## File map

**New files:**
- `scripts/sync-android-version.js`
- `.github/workflows/release.yml`
- `lib/update-check.ts`
- `lib/updater-client.ts`
- `components/UpdateBanner.tsx`
- `android/app/src/main/java/com/chaptercompanion/app/UpdaterPlugin.kt`

**Modified files:**
- `package.json` (add `@capacitor/app` dep, bump version)
- `scripts/mobile-build.js` (call sync script before build)
- `android/app/build.gradle` (signing config)
- `android/app/src/main/AndroidManifest.xml` (REQUEST_INSTALL_PACKAGES permission)
- `android/app/src/main/java/com/chaptercompanion/app/MainActivity.java` (register plugin)
- `app/layout.tsx` (mount banner)
- `components/SettingsModal.tsx` (add update row)
- `README.md` (one-time uninstall note + auto-update mention)

The existing `android/app/src/main/res/xml/file_paths.xml` already contains `<cache-path name="my_cache_images" path="."/>`, so no changes needed there. The existing FileProvider is already declared with authority `${applicationId}.fileprovider` — we reuse it.

---

## Task 1: Add `@capacitor/app` dependency

The TS update-check module needs `App.getInfo()` to read the running APK's versionName. `@capacitor/app` ships separately from `@capacitor/core`.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

```bash
npm install @capacitor/app@^6.0.0
```

- [ ] **Step 2: Verify it landed in `package.json` dependencies**

Open `package.json`, confirm a line like `"@capacitor/app": "^6.0.0"` appears in `dependencies`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @capacitor/app dep for runtime version lookup"
```

---

## Task 2: Create version sync script

Reads `version` from `package.json`, writes it into `android/app/build.gradle` as `versionName`, derives `versionCode` as `major*10000 + minor*100 + patch`. Idempotent. Throws on pattern mismatch.

**Files:**
- Create: `scripts/sync-android-version.js`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!m) {
  console.error(`sync-android-version: package.json version "${version}" must be MAJOR.MINOR.PATCH`);
  process.exit(1);
}
const [, major, minor, patch] = m.map(Number);
if (minor > 99 || patch > 99) {
  console.error(`sync-android-version: minor/patch must be <= 99 (got ${version})`);
  process.exit(1);
}
const versionCode = major * 10000 + minor * 100 + patch;

const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
const original = fs.readFileSync(gradlePath, 'utf8');

const nameRe = /(versionName\s+)"[^"]*"/;
const codeRe = /(versionCode\s+)\d+/;

if (!nameRe.test(original) || !codeRe.test(original)) {
  console.error('sync-android-version: could not find versionName/versionCode lines in build.gradle');
  process.exit(1);
}

const updated = original
  .replace(nameRe, `$1"${version}"`)
  .replace(codeRe, `$1${versionCode}`);

if (updated !== original) {
  fs.writeFileSync(gradlePath, updated);
  console.log(`sync-android-version: wrote versionName=${version}, versionCode=${versionCode}`);
} else {
  console.log(`sync-android-version: gradle already at ${version} (${versionCode})`);
}
```

- [ ] **Step 2: Run it once and verify it updates `build.gradle`**

```bash
node scripts/sync-android-version.js
```

Expected output: `sync-android-version: wrote versionName=0.1.0, versionCode=100` (because the current `package.json` is at `0.1.0`).

Open `android/app/build.gradle` and confirm `versionCode 100` and `versionName "0.1.0"` (replacing the previous `1` / `"1.0"`).

- [ ] **Step 3: Run it a second time to confirm idempotency**

```bash
node scripts/sync-android-version.js
```

Expected output: `sync-android-version: gradle already at 0.1.0 (100)`.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-android-version.js android/app/build.gradle
git commit -m "feat: sync android versionName/Code from package.json"
```

---

## Task 3: Wire sync script into mobile-build

The script must run before every Capacitor build so the APK that ships matches `package.json`.

**Files:**
- Modify: `scripts/mobile-build.js`

- [ ] **Step 1: Add the sync invocation**

Insert this block immediately after the `const isCapacitor = ...` line (around line 9) in `scripts/mobile-build.js`:

```js
// Keep android/app/build.gradle versionName/Code in sync with package.json
if (isCapacitor) {
  execSync('node scripts/sync-android-version.js', { stdio: 'inherit', cwd: root });
}
```

- [ ] **Step 2: Verify by running a Capacitor build dry-trigger**

```bash
node -e "process.env.NEXT_PUBLIC_CAPACITOR='true'; require('./scripts/mobile-build.js')" 2>&1 | head -5
```

You don't need to wait for the full Next build. Just confirm the first line printed is the sync script's output. Cancel with Ctrl+C after it starts the Next build.

- [ ] **Step 3: Commit**

```bash
git add scripts/mobile-build.js
git commit -m "feat: run sync-android-version before Capacitor build"
```

---

## Task 4: Bump package.json to 0.0.22 (the first auto-update-aware release)

This makes the very next release the one that introduces auto-updates. Existing v0.0.21 users will see a banner pointing here when they reopen the app — but because we're regenerating the keystore, they have to uninstall first (documented in Task 15).

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Edit version**

In `package.json` change `"version": "0.1.0"` to `"version": "0.0.22"`.

(The repo has been releasing `v0.0.X` tags but `package.json` was never bumped — we're aligning it to the release cadence now.)

- [ ] **Step 2: Sync gradle**

```bash
node scripts/sync-android-version.js
```

Expected output: `sync-android-version: wrote versionName=0.0.22, versionCode=22`.

- [ ] **Step 3: Commit**

```bash
git add package.json android/app/build.gradle
git commit -m "chore: align package.json version with release cadence (0.0.22)"
```

---

## Task 5: Generate release keystore (manual, user-driven)

This is a one-time setup step that produces secrets to add to GitHub Actions. The plan author cannot do this for you — the keystore is sensitive.

**Files:**
- Create: `android/release.keystore` (NOT committed — added to .gitignore)
- Modify: `.gitignore`

- [ ] **Step 1: Generate the keystore**

Run from the repo root (PowerShell):

```powershell
keytool -genkey -v `
  -keystore android/release.keystore `
  -alias bookbuddy `
  -keyalg RSA `
  -keysize 2048 `
  -validity 10000
```

When prompted, set a strong store password and key password. Record both — you'll need them for GitHub secrets.

- [ ] **Step 2: Add the keystore to .gitignore**

Append to `.gitignore`:

```
android/release.keystore
android/keystore.properties
```

- [ ] **Step 3: Base64-encode the keystore for GitHub secrets**

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("android/release.keystore")) | Set-Clipboard
```

The base64 string is now in your clipboard.

- [ ] **Step 4: Add four GitHub secrets**

In your repo settings (Settings → Secrets and variables → Actions → New repository secret), add:

| Secret name | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | (paste from clipboard) |
| `ANDROID_KEYSTORE_PASSWORD` | (the store password you set) |
| `ANDROID_KEY_ALIAS` | `bookbuddy` |
| `ANDROID_KEY_PASSWORD` | (the key password you set) |

- [ ] **Step 5: Commit the .gitignore change**

```bash
git add .gitignore
git commit -m "chore: ignore android release keystore"
```

---

## Task 6: Add signing config to build.gradle

Adds a `signingConfigs.release` block that reads from environment variables (set by CI) or falls back to `keystore.properties` (for local testing).

**Files:**
- Modify: `android/app/build.gradle`

- [ ] **Step 1: Add signing config**

In `android/app/build.gradle`, find the `android { ... defaultConfig { ... } }` block. After the `defaultConfig { ... }` closing brace and before `buildTypes { ... }`, insert:

```gradle
    signingConfigs {
        release {
            def envStore = System.getenv("ANDROID_KEYSTORE_PATH")
            def envStorePass = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            def envAlias = System.getenv("ANDROID_KEY_ALIAS")
            def envKeyPass = System.getenv("ANDROID_KEY_PASSWORD")

            if (envStore != null) {
                storeFile file(envStore)
                storePassword envStorePass
                keyAlias envAlias
                keyPassword envKeyPass
            } else {
                def propsFile = rootProject.file("keystore.properties")
                if (propsFile.exists()) {
                    def props = new Properties()
                    propsFile.withInputStream { props.load(it) }
                    storeFile file(props['storeFile'])
                    storePassword props['storePassword']
                    keyAlias props['keyAlias']
                    keyPassword props['keyPassword']
                }
            }
        }
    }
```

- [ ] **Step 2: Wire it into the release build type**

In the same file, replace the `buildTypes { release { ... } }` block with:

```gradle
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
            signingConfig signingConfigs.release
        }
    }
```

- [ ] **Step 3: Commit**

```bash
git add android/app/build.gradle
git commit -m "feat: signed release build via env vars or keystore.properties"
```

---

## Task 7: Create release workflow

Tag-triggered workflow that builds the signed APK and attaches it to the matching GitHub Release.

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Release Android APK
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      tag:
        description: Tag to attach the APK to (e.g. v0.0.22)
        required: true

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17

      - uses: android-actions/setup-android@v3

      - name: Install npm deps
        run: npm ci

      - name: Build Capacitor web bundle
        run: npm run build:capacitor

      - name: Sync Capacitor
        run: npx cap sync android

      - name: Decode keystore
        run: |
          echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > $RUNNER_TEMP/release.keystore
          echo "ANDROID_KEYSTORE_PATH=$RUNNER_TEMP/release.keystore" >> $GITHUB_ENV

      - name: Build signed APK
        env:
          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        working-directory: android
        run: ./gradlew assembleRelease

      - name: Resolve tag
        id: tag
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "tag=${{ github.event.inputs.tag }}" >> $GITHUB_OUTPUT
          else
            echo "tag=${GITHUB_REF#refs/tags/}" >> $GITHUB_OUTPUT
          fi

      - name: Upload APK to release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ steps.tag.outputs.tag }}
          files: android/app/build/outputs/apk/release/app-release.apk
          fail_on_unmatched_files: true
```

- [ ] **Step 2: Verify YAML is valid**

```bash
node -e "const yaml=require('yaml'); yaml.parse(require('fs').readFileSync('.github/workflows/release.yml','utf8')); console.log('ok')"
```

If the `yaml` package isn't available locally, skip this step — GitHub will validate on push.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: tag-triggered signed APK release workflow"
```

The workflow runs on the next `v*` tag push. Don't tag yet — finish the rest of the plan first.

---

## Task 8: Add REQUEST_INSTALL_PACKAGES permission

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Add the permission**

In `android/app/src/main/AndroidManifest.xml`, immediately after the `<uses-permission android:name="android.permission.INTERNET" />` line near the bottom, add:

```xml
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

- [ ] **Step 2: Commit**

```bash
git add android/app/src/main/AndroidManifest.xml
git commit -m "feat: declare REQUEST_INSTALL_PACKAGES for self-update flow"
```

---

## Task 9: Create UpdaterPlugin.kt

Capacitor Kotlin plugin with two methods: `download(url)` streams an APK to cacheDir with progress events, and `install(path)` hands off to Android's system installer via FileProvider.

**Files:**
- Create: `android/app/src/main/java/com/chaptercompanion/app/UpdaterPlugin.kt`

- [ ] **Step 1: Write the plugin**

```kotlin
package com.chaptercompanion.app

import android.content.Intent
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.*
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

@CapacitorPlugin(name = "UpdaterPlugin")
class UpdaterPlugin : Plugin() {
    private var downloadJob: Job? = null

    @PluginMethod
    fun download(call: PluginCall) {
        val urlStr = call.getString("url") ?: return call.reject("Missing url")
        val cacheDir = context.cacheDir
        val tempDest = File(cacheDir, "bookbuddy-update.apk.part")
        val finalDest = File(cacheDir, "bookbuddy-update.apk")

        // Cancel any in-flight download before starting a new one
        downloadJob?.cancel()
        if (tempDest.exists()) tempDest.delete()

        downloadJob = CoroutineScope(Dispatchers.IO).launch {
            try {
                val conn = followRedirects(URL(urlStr))
                if (conn.responseCode !in 200..299) {
                    call.reject("Download failed: HTTP ${conn.responseCode}")
                    return@launch
                }

                val totalBytes = conn.contentLengthLong
                var bytesDownloaded = 0L
                val buffer = ByteArray(8192)
                var lastProgressEmit = 0L

                conn.inputStream.use { input ->
                    FileOutputStream(tempDest).use { output ->
                        while (isActive) {
                            val read = input.read(buffer)
                            if (read == -1) break
                            output.write(buffer, 0, read)
                            bytesDownloaded += read

                            // Emit progress at most every 256 KB
                            if (bytesDownloaded - lastProgressEmit >= 256 * 1024) {
                                lastProgressEmit = bytesDownloaded
                                val percent = if (totalBytes > 0) {
                                    ((bytesDownloaded * 100) / totalBytes).toInt()
                                } else 0
                                val progress = JSObject()
                                progress.put("percent", percent)
                                progress.put("bytesDownloaded", bytesDownloaded)
                                progress.put("totalBytes", totalBytes)
                                notifyListeners("progress", progress)
                            }
                        }
                    }
                }

                if (!isActive) {
                    tempDest.delete()
                    call.reject("Download cancelled")
                    return@launch
                }

                if (finalDest.exists()) finalDest.delete()
                tempDest.renameTo(finalDest)

                val result = JSObject()
                result.put("path", finalDest.absolutePath)
                call.resolve(result)
            } catch (e: Exception) {
                tempDest.delete()
                call.reject("Download failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        downloadJob?.cancel()
        downloadJob = null
        call.resolve()
    }

    @PluginMethod
    fun install(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("Missing path")
        val apk = File(path)
        if (!apk.exists()) return call.reject("APK not found at $path")

        try {
            val authority = "${context.packageName}.fileprovider"
            val uri = FileProvider.getUriForFile(context, authority, apk)

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Install failed: ${e.message}")
        }
    }

    private fun followRedirects(initial: URL, maxHops: Int = 5): HttpURLConnection {
        var url = initial
        var hops = 0
        while (true) {
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("User-Agent", "BookBuddy-Updater")
            conn.connect()
            val code = conn.responseCode
            if (code in 300..399 && hops < maxHops) {
                val location = conn.getHeaderField("Location") ?: return conn
                conn.disconnect()
                url = URL(url, location)
                hops++
                continue
            }
            return conn
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

You can either open Android Studio and let it index, or run a quick gradle compile from the command line:

```bash
cd android && ./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`. If the GitHub Releases redirect (browser) URL is used, the `followRedirects` helper handles the 302 to the S3 download URL.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/chaptercompanion/app/UpdaterPlugin.kt
git commit -m "feat: UpdaterPlugin for APK download + system install"
```

---

## Task 10: Register plugin in MainActivity

**Files:**
- Modify: `android/app/src/main/java/com/chaptercompanion/app/MainActivity.java`

- [ ] **Step 1: Add the registration**

Replace the `onCreate` body in `MainActivity.java` so the file looks like:

```java
package com.chaptercompanion.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(LlamaPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd android && ./gradlew :app:compileDebugKotlin :app:compileDebugJavaWithJavac
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/chaptercompanion/app/MainActivity.java
git commit -m "feat: register UpdaterPlugin in MainActivity"
```

---

## Task 11: Create updater-client.ts (TS facade over the plugin)

Thin typed wrapper so UI code never touches `Capacitor.Plugins.UpdaterPlugin` directly.

**Files:**
- Create: `lib/updater-client.ts`

- [ ] **Step 1: Write the facade**

```ts
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface UpdaterPlugin {
  download(options: { url: string }): Promise<{ path: string }>;
  cancel(): Promise<void>;
  install(options: { path: string }): Promise<void>;
  addListener(
    eventName: 'progress',
    listener: (event: { percent: number; bytesDownloaded: number; totalBytes: number }) => void,
  ): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<UpdaterPlugin>('UpdaterPlugin');

export function isUpdaterAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function downloadApk(
  url: string,
  onProgress?: (percent: number) => void,
): Promise<string> {
  if (!isUpdaterAvailable()) throw new Error('UpdaterPlugin not available on this platform');

  let handle: PluginListenerHandle | undefined;
  if (onProgress) {
    handle = await plugin.addListener('progress', (e) => onProgress(e.percent));
  }
  try {
    const { path } = await plugin.download({ url });
    return path;
  } finally {
    handle?.remove();
  }
}

export async function installApk(path: string): Promise<void> {
  if (!isUpdaterAvailable()) throw new Error('UpdaterPlugin not available on this platform');
  await plugin.install({ path });
}

export async function cancelDownload(): Promise<void> {
  if (!isUpdaterAvailable()) return;
  await plugin.cancel();
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: clean exit, no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/updater-client.ts
git commit -m "feat: typed facade over UpdaterPlugin"
```

---

## Task 12: Create update-check.ts

Polls the GitHub Releases API, caches result in `localStorage` with 6h TTL (30 min on error), short-circuits on web.

**Files:**
- Create: `lib/update-check.ts`

- [ ] **Step 1: Write the module**

```ts
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

const RELEASES_URL = 'https://api.github.com/repos/alex-potter/bookbuddy/releases/latest';
const CACHE_KEY = 'updateCheck.cache';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;        // 6 hours on success
const CACHE_TTL_ERROR_MS = 30 * 60 * 1000;      // 30 min on error
const ASSET_NAME = 'app-release.apk';

export type UpdateStatus =
  | { available: true; latestVersion: string; apkUrl: string; releaseNotes: string; checkedAt: number }
  | { available: false; checkedAt: number };

interface CacheEntry extends Object {
  status: UpdateStatus;
  ttlMs: number;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function readCache(): CacheEntry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // quota or private mode — ignore
  }
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.status.checkedAt < entry.ttlMs;
}

export function getLastChecked(): number | null {
  const entry = readCache();
  return entry ? entry.status.checkedAt : null;
}

export async function checkForUpdate(opts?: { force?: boolean }): Promise<UpdateStatus> {
  const force = opts?.force ?? false;

  // Web/PWA: never run the check
  if (!Capacitor.isNativePlatform()) {
    return { available: false, checkedAt: Date.now() };
  }

  const cached = readCache();
  if (cached && !force && isFresh(cached)) {
    return cached.status;
  }

  let runningVersion: string;
  try {
    const info = await App.getInfo();
    runningVersion = info.version;
  } catch {
    const status: UpdateStatus = { available: false, checkedAt: Date.now() };
    writeCache({ status, ttlMs: CACHE_TTL_ERROR_MS });
    return status;
  }

  try {
    const res = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
    const json = await res.json();

    if (json.prerelease === true) {
      const status: UpdateStatus = { available: false, checkedAt: Date.now() };
      writeCache({ status, ttlMs: CACHE_TTL_MS });
      return status;
    }

    const tag: string = typeof json.tag_name === 'string' ? json.tag_name : '';
    const latestVersion = tag.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(latestVersion)) {
      const status: UpdateStatus = { available: false, checkedAt: Date.now() };
      writeCache({ status, ttlMs: CACHE_TTL_MS });
      return status;
    }

    const apkAsset = (json.assets ?? []).find((a: { name?: string; browser_download_url?: string }) => a.name === ASSET_NAME);
    if (!apkAsset?.browser_download_url) {
      const status: UpdateStatus = { available: false, checkedAt: Date.now() };
      writeCache({ status, ttlMs: CACHE_TTL_MS });
      return status;
    }

    if (compareSemver(latestVersion, runningVersion) <= 0) {
      const status: UpdateStatus = { available: false, checkedAt: Date.now() };
      writeCache({ status, ttlMs: CACHE_TTL_MS });
      return status;
    }

    const status: UpdateStatus = {
      available: true,
      latestVersion,
      apkUrl: apkAsset.browser_download_url,
      releaseNotes: typeof json.body === 'string' ? json.body : '',
      checkedAt: Date.now(),
    };
    writeCache({ status, ttlMs: CACHE_TTL_MS });
    return status;
  } catch (err) {
    console.warn('[update-check] failed', err);
    const status: UpdateStatus = { available: false, checkedAt: Date.now() };
    writeCache({ status, ttlMs: CACHE_TTL_ERROR_MS });
    return status;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: clean exit.

- [ ] **Step 3: Commit**

```bash
git add lib/update-check.ts
git commit -m "feat: GitHub Releases poll with 6h cache + semver compare"
```

---

## Task 13: Create UpdateBanner component

Dismissible bar that mounts at the top of the app shell, drives the full download → install flow.

**Files:**
- Create: `components/UpdateBanner.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { checkForUpdate, type UpdateStatus } from '@/lib/update-check';
import { downloadApk, installApk, isUpdaterAvailable } from '@/lib/updater-client';

type BannerState =
  | { kind: 'hidden' }
  | { kind: 'available'; latestVersion: string; apkUrl: string }
  | { kind: 'downloading'; latestVersion: string; percent: number }
  | { kind: 'ready'; latestVersion: string; path: string }
  | { kind: 'installing' }
  | { kind: 'error'; message: string; latestVersion: string; apkUrl: string };

export default function UpdateBanner() {
  const [state, setState] = useState<BannerState>({ kind: 'hidden' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isUpdaterAvailable()) return;
    let cancelled = false;
    (async () => {
      const status: UpdateStatus = await checkForUpdate();
      if (cancelled) return;
      if (status.available) {
        setState({ kind: 'available', latestVersion: status.latestVersion, apkUrl: status.apkUrl });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || state.kind === 'hidden') return null;

  async function startInstall(latestVersion: string, apkUrl: string) {
    setState({ kind: 'downloading', latestVersion, percent: 0 });
    try {
      const path = await downloadApk(apkUrl, (percent) => {
        setState({ kind: 'downloading', latestVersion, percent });
      });
      setState({ kind: 'ready', latestVersion, path });
      setState({ kind: 'installing' });
      await installApk(path);
      // App will be replaced by the system installer; no further state changes expected
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Install failed';
      setState({ kind: 'error', message, latestVersion, apkUrl });
    }
  }

  return (
    <div className="fixed top-0 inset-x-0 z-50 bg-paper text-ink border-b border-ink/10 px-3 py-2 text-sm flex items-center gap-3 shadow">
      <div className="flex-1 min-w-0">
        {state.kind === 'available' && (
          <span>BookBuddy v{state.latestVersion} is available.</span>
        )}
        {state.kind === 'downloading' && (
          <span>Downloading v{state.latestVersion}… {state.percent}%</span>
        )}
        {state.kind === 'ready' && (
          <span>Ready to install v{state.latestVersion}…</span>
        )}
        {state.kind === 'installing' && <span>Installing…</span>}
        {state.kind === 'error' && (
          <span className="text-red-700">Update failed: {state.message}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {state.kind === 'available' && (
          <button
            type="button"
            className="px-3 py-1 rounded bg-ink text-paper text-xs"
            onClick={() => startInstall(state.latestVersion, state.apkUrl)}
          >
            Install
          </button>
        )}
        {state.kind === 'error' && (
          <button
            type="button"
            className="px-3 py-1 rounded bg-ink text-paper text-xs"
            onClick={() => startInstall(state.latestVersion, state.apkUrl)}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss update banner"
          className="px-2 py-1 rounded text-ink/60 text-xs"
          onClick={() => setDismissed(true)}
        >
          ×
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript + build**

```bash
npx tsc --noEmit
```

Expected: clean exit.

- [ ] **Step 3: Commit**

```bash
git add components/UpdateBanner.tsx
git commit -m "feat: UpdateBanner with download + install flow"
```

---

## Task 14: Mount UpdateBanner in app/layout.tsx

The banner is a pure no-op when `isUpdaterAvailable()` returns false, so it's safe to render unconditionally — but for good measure we gate the import path-style. Since the component itself short-circuits, just render it.

**Files:**
- Modify: `app/layout.tsx`

- [ ] **Step 1: Import the banner**

In `app/layout.tsx`, add this import at the top (alongside the existing `import PwaProviders from './PwaProviders';`):

```tsx
import UpdateBanner from '@/components/UpdateBanner';
```

- [ ] **Step 2: Mount the banner**

In the `<body>` element, change:

```tsx
<body className="min-h-dvh antialiased">
  {children}
  {!isCapacitor && <PwaProviders />}
</body>
```

to:

```tsx
<body className="min-h-dvh antialiased">
  <UpdateBanner />
  {children}
  {!isCapacitor && <PwaProviders />}
</body>
```

- [ ] **Step 3: Verify the build still works**

```bash
npx tsc --noEmit
```

Then in a separate terminal, optionally:

```bash
npm run dev
```

Open `http://localhost:3000`. Confirm the banner is NOT visible (we're on web; `isUpdaterAvailable()` returns false). Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add app/layout.tsx
git commit -m "feat: mount UpdateBanner in root layout"
```

---

## Task 15: Add update row to SettingsModal

A row showing the current version, a manual "Check now" button, and the last-checked timestamp.

**Files:**
- Modify: `components/SettingsModal.tsx`

- [ ] **Step 1: Add imports**

At the top of `components/SettingsModal.tsx` (with the other imports), add:

```tsx
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { checkForUpdate, getLastChecked } from '@/lib/update-check';
```

- [ ] **Step 2: Add state + effect inside the component**

Inside `export default function SettingsModal({ onClose }: Props) {` (after the existing `const [settings, setSettings] = useState<...>(...)`), add:

```tsx
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<number | null>(getLastChecked());
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const isNative = Capacitor.isNativePlatform();

  useEffect(() => {
    if (!isNative) return;
    App.getInfo().then((info) => setAppVersion(info.version)).catch(() => {});
  }, [isNative]);

  async function handleCheckForUpdate() {
    setCheckBusy(true);
    setCheckResult(null);
    try {
      const status = await checkForUpdate({ force: true });
      setLastChecked(status.checkedAt);
      setCheckResult(status.available ? `Update available: v${status.latestVersion}` : 'You are on the latest version.');
    } catch (e) {
      setCheckResult(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setCheckBusy(false);
    }
  }
```

If `useEffect` is not already imported, add it to the existing `react` import.

- [ ] **Step 3: Render the row**

Find the closing `</div>` of the modal body content (the one that wraps all the AI settings sections — search for the section that ends just before the `'Saved ✓' : 'Save Settings'` button block). Insert this new section just before the save button area:

```tsx
          {isNative && (
            <section className="mb-4 border-t border-ink/10 pt-4">
              <h3 className="font-bold text-ink text-sm mb-2">App version</h3>
              <p className="text-xs text-ink/70 mb-2">
                Installed: v{appVersion ?? '…'}
                {lastChecked && (
                  <> · Last checked: {new Date(lastChecked).toLocaleString()}</>
                )}
              </p>
              <button
                type="button"
                disabled={checkBusy}
                onClick={handleCheckForUpdate}
                className="px-3 py-1 rounded bg-ink text-paper text-xs disabled:opacity-50"
              >
                {checkBusy ? 'Checking…' : 'Check for updates'}
              </button>
              {checkResult && <p className="text-xs text-ink/70 mt-2">{checkResult}</p>}
            </section>
          )}
```

If you're unsure exactly where to place it, the safest spot is immediately after the last `</section>` and before the save button row near the bottom of the JSX.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: clean exit.

- [ ] **Step 5: Commit**

```bash
git add components/SettingsModal.tsx
git commit -m "feat: app version + manual update-check row in Settings"
```

---

## Task 16: Update README

Document auto-updates and the one-time uninstall requirement for v0.0.21 → v0.0.22 transition.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Edit the Android APK section**

Find the "Updates are not automatic" line (around `README.md:138`) and replace it with:

```markdown
**Auto-update:** Starting in v0.0.22 the app checks for new releases on launch and offers a one-tap install. You can also trigger a manual check from **Settings → App version**.

**Upgrading from v0.0.21 or earlier:** v0.0.22 is signed with a new keystore. The first install must be done manually after **uninstalling** the existing app (Android refuses to replace an APK signed with a different key). All updates from v0.0.22 onward install over the top automatically.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: explain auto-update + one-time uninstall for keystore change"
```

---

## Task 17: End-to-end manual verification

This is the final sign-off. Each scenario corresponds to one in the spec's testing section.

- [ ] **Step 1: Verify dev server short-circuits the check**

```bash
npm run dev
```

Open `http://localhost:3000`. Open DevTools → Network. Confirm:
- No request to `api.github.com/repos/alex-potter/bookbuddy/releases/latest` is made.
- No update banner is visible.

Stop the server.

- [ ] **Step 2: Build a local v0.0.22 APK and install it**

```bash
npm run cap:sync
cd android && ./gradlew assembleRelease
```

Expected: `app-release.apk` produced under `android/app/build/outputs/apk/release/`. The build will succeed only if a `keystore.properties` exists at `android/keystore.properties` OR `ANDROID_KEYSTORE_PATH` is set in env. Create `android/keystore.properties` (already gitignored from Task 5):

```properties
storeFile=release.keystore
storePassword=YOUR_STORE_PASSWORD
keyAlias=bookbuddy
keyPassword=YOUR_KEY_PASSWORD
```

Then re-run `./gradlew assembleRelease`. Install the APK on a physical device:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

(`-r` will fail if you previously had a different-keystore install — uninstall first via `adb uninstall com.chaptercompanion.app`.)

Open the app. In Settings → App version, confirm it reports `v0.0.22`.

- [ ] **Step 3: Cut a v0.0.23 test release via the workflow**

In `package.json` bump `version` to `0.0.23`, run `node scripts/sync-android-version.js`, commit, push.

```bash
git tag v0.0.23
git push origin v0.0.23
```

Watch the Actions tab for the `Release Android APK` workflow. When green, confirm `v0.0.23` release exists with `app-release.apk` attached.

- [ ] **Step 4: Verify in-app update flow**

Reopen the v0.0.22 app on the device. Within a few seconds the banner should appear: "BookBuddy v0.0.23 is available."

Tap **Install**. Watch the percentage tick up. When it hits 100%, Android's system install prompt appears. Confirm install. App restarts.

In Settings → App version, confirm `v0.0.23`.

- [ ] **Step 5: Verify pre-release filter**

Bump to `0.0.24`, push tag `v0.0.24`, but mark the GitHub release as **pre-release**. Reopen the app. Banner must NOT appear. Tap "Check for updates" in Settings → confirm message says you're on the latest.

- [ ] **Step 6: Verify offline behaviour**

Toggle airplane mode. Open Settings → tap "Check for updates". Confirm a non-crashing error message in the banner area. Re-enable network — `localStorage.removeItem('updateCheck.cache')` in DevTools (or wait 30 min) before retesting normal flow.

- [ ] **Step 7: Verify cancel during download**

On a slow network, tap Install, then dismiss the banner mid-download. Re-open the banner (close and reopen app). Confirm `bookbuddy-update.apk.part` is gone from the cache dir (`adb shell run-as com.chaptercompanion.app ls cache/`).

- [ ] **Step 8: Final commit + push**

If any docs need touching up after the manual run, commit. Otherwise:

```bash
git push origin main
```

The plan is complete.

---

## Self-review notes

- **Spec coverage:** All five components from the spec are present (Tasks 2/3/4 → versioning; 5/6/7 → release pipeline; 8/9/10/11 → native plugin + manifest; 12 → update-check client; 13/14/15 → UI). Documentation updated in Task 16. Manual test plan in Task 17 mirrors the spec's testing section.
- **Out-of-scope items:** Background WorkManager checks, silent download, per-version dismissal, iOS, Play Store, delta updates — none added.
- **Type consistency:** `UpdateStatus` shape matches between `update-check.ts` and `UpdateBanner.tsx`. `downloadApk(url, onProgress)` signature matches calls in `UpdateBanner`. Plugin method names (`download`, `cancel`, `install`) match between `UpdaterPlugin.kt` and `lib/updater-client.ts`.
- **Known sequencing:** Task 5 (keystore) and Task 7 (workflow) can technically be done in either order, but doing Task 5 first means the workflow has secrets to consume on its very first run. Task 17 step 3 is the first time the workflow actually runs end-to-end.
