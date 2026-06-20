package com.audioreadnative.tts

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.getOfflineTtsConfig
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.Executors
import kotlin.math.max

private const val TAG = "AudioReadKokoro"
private const val MODEL_DIR = "kokoro-en-v0_19"

class KokoroTtsModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  private val executor = Executors.newSingleThreadExecutor()
  private var tts: OfflineTts? = null
  private var track: AudioTrack? = null
  @Volatile private var stopped = false

  override fun getName() = "KokoroTts"

  @ReactMethod
  fun initialize(promise: Promise) {
    executor.execute {
      try {
        ensureTts()
        val map = Arguments.createMap()
        map.putInt("sampleRate", tts!!.sampleRate())
        map.putInt("speakers", tts!!.numSpeakers())
        map.putString("model", MODEL_DIR)
        promise.resolve(map)
      } catch (e: Throwable) {
        Log.e(TAG, "initialize failed", e)
        promise.reject("KOKORO_INIT_FAILED", e.message, e)
      }
    }
  }

  @ReactMethod
  fun speak(text: String, speakerId: Int, speed: Double, promise: Promise) {
    executor.execute {
      try {
        val model = ensureTts()
        val audioTrack = ensureAudioTrack(model.sampleRate())
        val cleanText = text.trim()
        if (cleanText.isEmpty()) {
          promise.reject("EMPTY_TEXT", "Enter text before speaking")
          return@execute
        }

        stopped = false
        audioTrack.pause()
        audioTrack.flush()
        audioTrack.play()

        val start = System.nanoTime()
        val audio = model.generateWithConfigAndCallback(
          text = cleanText,
          config = GenerationConfig(
            sid = max(0, speakerId),
            speed = speed.toFloat().coerceIn(0.5f, 2.0f),
            silenceScale = 0.2f,
          ),
          callback = { samples ->
            if (stopped) {
              0
            } else {
              audioTrack.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
              1
            }
          },
        )
        val elapsed = (System.nanoTime() - start) / 1_000_000_000.0
        val audioDuration = audio.samples.size.toDouble() / audio.sampleRate.toDouble()

        val map = Arguments.createMap()
        map.putDouble("elapsedSeconds", elapsed)
        map.putDouble("audioDurationSeconds", audioDuration)
        map.putDouble("rtf", if (audioDuration > 0.0) elapsed / audioDuration else 0.0)
        map.putInt("sampleRate", audio.sampleRate)
        map.putInt("samples", audio.samples.size)
        promise.resolve(map)
      } catch (e: Throwable) {
        Log.e(TAG, "speak failed", e)
        promise.reject("KOKORO_SPEAK_FAILED", e.message, e)
      }
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    executor.execute {
      stopped = true
      track?.pause()
      track?.flush()
      promise.resolve(null)
    }
  }

  override fun invalidate() {
    stopped = true
    track?.release()
    track = null
    tts?.release()
    tts = null
    executor.shutdownNow()
    super.invalidate()
  }

  private fun ensureTts(): OfflineTts {
    tts?.let { return it }

    assertAsset("$MODEL_DIR/model.onnx")
    assertAsset("$MODEL_DIR/voices.bin")
    assertAsset("$MODEL_DIR/tokens.txt")

    val dataDirAsset = "$MODEL_DIR/espeak-ng-data"
    val dataRoot = copyDataDir(dataDirAsset)
    val config = getOfflineTtsConfig(
      modelDir = MODEL_DIR,
      modelName = "model.onnx",
      acousticModelName = "",
      vocoder = "",
      voices = "voices.bin",
      lexicon = "",
      dataDir = "$dataRoot/$dataDirAsset",
      dictDir = "",
      ruleFsts = "",
      ruleFars = "",
      numThreads = 4,
    )
    return OfflineTts(assetManager = reactContext.assets, config = config).also { tts = it }
  }

  private fun ensureAudioTrack(sampleRate: Int): AudioTrack {
    track?.let { return it }

    val minBufferSize = AudioTrack.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_FLOAT,
    )
    val attrs = AudioAttributes.Builder()
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .build()
    val format = AudioFormat.Builder()
      .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
      .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
      .setSampleRate(sampleRate)
      .build()
    return AudioTrack(
      attrs,
      format,
      minBufferSize,
      AudioTrack.MODE_STREAM,
      AudioManager.AUDIO_SESSION_ID_GENERATE,
    ).also { track = it }
  }

  private fun assertAsset(path: String) {
    try {
      reactContext.assets.open(path).use { }
    } catch (e: IOException) {
      throw IllegalStateException(
        "Missing Android asset $path. Run scripts/setup-kokoro-android.sh from native/AudioReadNative.",
        e,
      )
    }
  }

  private fun copyDataDir(path: String): String {
    copyAssets(path)
    return reactContext.getExternalFilesDir(null)!!.absolutePath
  }

  private fun copyAssets(path: String) {
    val entries = reactContext.assets.list(path) ?: emptyArray()
    if (entries.isEmpty()) {
      copyFile(path)
      return
    }

    File(reactContext.getExternalFilesDir(null), path).mkdirs()
    entries.forEach { child ->
      copyAssets("$path/$child")
    }
  }

  private fun copyFile(path: String) {
    val outFile = File(reactContext.getExternalFilesDir(null), path)
    if (outFile.exists() && outFile.length() > 0) return
    outFile.parentFile?.mkdirs()
    reactContext.assets.open(path).use { input ->
      FileOutputStream(outFile).use { output ->
        input.copyTo(output)
      }
    }
  }
}
