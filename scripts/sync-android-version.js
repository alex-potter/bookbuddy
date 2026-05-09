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
