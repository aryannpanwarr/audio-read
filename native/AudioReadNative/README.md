# Audio Read Native

React Native Android prototype for testing Kokoro on-device with `sherpa-onnx`.

## What it does

- Loads Kokoro English model assets from Android assets.
- Calls native Kotlin/JNI through a React Native module.
- Streams generated audio through Android `AudioTrack`.
- Reports real-time factor (RTF). RTF below `1.0` means synthesis is faster than playback.

## Build

The repo includes local setup scripts and expects the model/native binaries to be local, ignored build assets.

```bash
npm install
./scripts/setup-kokoro-android.sh
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

The APK is large because it packages Kokoro locally.

## Crash Logs

Each app launch writes a new run log under app-private storage. Use **Export logs** in the app to share a text file containing the latest runs. If Kokoro crashes during Initialize or Speak, reopen the app and tap **Export logs** before trying again.
