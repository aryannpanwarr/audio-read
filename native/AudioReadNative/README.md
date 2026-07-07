# Audio Read Native

React Native Android reader that imports PDF, EPUB, and TXT files and reads them with Android system TTS.

## What it does

- Keeps a local document library.
- Uses Android's installed offline/system voices through `TextToSpeech`.
- Supports foreground playback controls and exportable logs.

## Build

```bash
npm install
./scripts/build-android-release.sh
```

The release APK is:

```text
android/app/build/outputs/apk/release/app-release.apk
```

## Install on Android

Enable USB debugging, connect the phone, accept the RSA prompt, then run:

```bash
.toolchains/android-sdk/platform-tools/adb install -r android/app/build/outputs/apk/release/app-release.apk
```

The APK does not bundle a neural TTS model. Voice quality and offline support depend on the Android TTS engine installed on the phone.

## Crash Logs

Each app launch writes a new run log under app-private storage. Use **Export logs** in the app to share a text file containing the latest runs.
