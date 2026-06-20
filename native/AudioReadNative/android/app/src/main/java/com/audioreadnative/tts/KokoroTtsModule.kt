package com.audioreadnative.tts

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import androidx.core.content.ContextCompat
import com.audioreadnative.AudioReadPlaybackService
import com.audioreadnative.PLAYBACK_COMMAND_ACTION
import com.audioreadnative.PLAYBACK_COMMAND_EXTRA
import androidx.core.content.FileProvider
import com.audioreadnative.LogStore
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
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
  private val commandReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action != PLAYBACK_COMMAND_ACTION) return
      val command = intent.getStringExtra(PLAYBACK_COMMAND_EXTRA) ?: return
      LogStore.write(TAG, "playback command received command=$command")
      emitPlaybackCommand(command)
    }
  }

  init {
    ContextCompat.registerReceiver(
      reactContext,
      commandReceiver,
      IntentFilter(PLAYBACK_COMMAND_ACTION),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
  }

  override fun getName() = "KokoroTts"

  @ReactMethod
  fun initialize(promise: Promise) {
    LogStore.write(TAG, "initialize requested")
    executor.execute {
      try {
        ensureTts()
        val map = Arguments.createMap()
        map.putInt("sampleRate", tts!!.sampleRate())
        map.putInt("speakers", tts!!.numSpeakers())
        map.putString("model", MODEL_DIR)
        LogStore.write(TAG, "initialize resolved sampleRate=${tts!!.sampleRate()} speakers=${tts!!.numSpeakers()}")
        promise.resolve(map)
      } catch (e: Throwable) {
        Log.e(TAG, "initialize failed", e)
        LogStore.write(TAG, "initialize failed: ${e.stackTraceToString()}")
        promise.reject("KOKORO_INIT_FAILED", e.message, e)
      }
    }
  }

  @ReactMethod
  fun speak(text: String, speakerId: Int, speed: Double, promise: Promise) {
    LogStore.write(TAG, "speak requested chars=${text.length} speakerId=$speakerId speed=$speed")
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

        LogStore.write(TAG, "speak generating audio without native callback")
        val start = System.nanoTime()
        val audio = model.generateWithConfig(
          text = cleanText,
          config = GenerationConfig(
            sid = max(0, speakerId),
            speed = speed.toFloat().coerceIn(0.5f, 2.0f),
            silenceScale = 0.2f,
          ),
        )
        val elapsed = (System.nanoTime() - start) / 1_000_000_000.0
        val audioDuration = audio.samples.size.toDouble() / audio.sampleRate.toDouble()
        val rtf = if (audioDuration > 0.0) elapsed / audioDuration else 0.0
        LogStore.write(
          TAG,
          "speak resolved elapsed=${"%.3f".format(elapsed)} audioDuration=${"%.3f".format(audioDuration)} rtf=${"%.3f".format(rtf)} samples=${audio.samples.size}",
        )
        if (!stopped && audio.samples.isNotEmpty()) {
          emitSpeechTiming(audioDuration, cleanText.wordCount())
          LogStore.write(TAG, "speak writing ${audio.samples.size} samples to AudioTrack")
          audioTrack.write(audio.samples, 0, audio.samples.size, AudioTrack.WRITE_BLOCKING)
          LogStore.write(TAG, "speak finished AudioTrack write")
        }

        val map = Arguments.createMap()
        map.putDouble("elapsedSeconds", elapsed)
        map.putDouble("audioDurationSeconds", audioDuration)
        map.putDouble("rtf", rtf)
        map.putInt("sampleRate", audio.sampleRate)
        map.putInt("samples", audio.samples.size)
        promise.resolve(map)
      } catch (e: Throwable) {
        Log.e(TAG, "speak failed", e)
        LogStore.write(TAG, "speak failed: ${e.stackTraceToString()}")
        promise.reject("KOKORO_SPEAK_FAILED", e.message, e)
      }
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    LogStore.write(TAG, "stop requested")
    executor.execute {
      stopped = true
      track?.pause()
      track?.flush()
      LogStore.write(TAG, "stop resolved")
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun startPlaybackSession(promise: Promise) {
    try {
      LogStore.write(TAG, "startPlaybackSession requested")
      ContextCompat.startForegroundService(
        reactContext,
        AudioReadPlaybackService.startIntent(reactContext),
      )
      promise.resolve(null)
    } catch (e: Throwable) {
      LogStore.write(TAG, "startPlaybackSession failed: ${e.stackTraceToString()}")
      promise.reject("PLAYBACK_SERVICE_START_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun stopPlaybackSession(promise: Promise) {
    try {
      LogStore.write(TAG, "stopPlaybackSession requested")
      reactContext.startService(AudioReadPlaybackService.stopIntent(reactContext))
      promise.resolve(null)
    } catch (e: Throwable) {
      LogStore.write(TAG, "stopPlaybackSession failed: ${e.stackTraceToString()}")
      promise.reject("PLAYBACK_SERVICE_STOP_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun addListener(eventName: String) {
    LogStore.write(TAG, "js listener added event=$eventName")
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    LogStore.write(TAG, "js listeners removed count=$count")
  }

  @ReactMethod
  fun record(message: String, promise: Promise) {
    LogStore.write("js", message)
    promise.resolve(null)
  }

  @ReactMethod
  fun exportLogs(promise: Promise) {
    try {
      LogStore.write(TAG, "exportLogs requested")
      val file = LogStore.exportFile(reactContext)
      val uri = FileProvider.getUriForFile(
        reactContext,
        "${reactContext.packageName}.fileprovider",
        file,
      )
      val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(Intent.createChooser(intent, "Export Audio Read logs").apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      })
      promise.resolve(file.absolutePath)
    } catch (e: Throwable) {
      LogStore.write(TAG, "exportLogs failed: ${e.stackTraceToString()}")
      promise.reject("LOG_EXPORT_FAILED", e.message, e)
    }
  }

  override fun invalidate() {
    LogStore.write(TAG, "invalidate")
    stopped = true
    try {
      reactContext.unregisterReceiver(commandReceiver)
    } catch (_: Throwable) {
    }
    track?.release()
    track = null
    tts?.release()
    tts = null
    executor.shutdownNow()
    super.invalidate()
  }

  private fun emitPlaybackCommand(command: String) {
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AudioReadPlaybackCommand", command)
  }

  private fun emitSpeechTiming(audioDuration: Double, wordCount: Int) {
    val map = Arguments.createMap().apply {
      putDouble("audioDurationSeconds", audioDuration)
      putInt("wordCount", wordCount)
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AudioReadSpeechTiming", map)
  }

  private fun ensureTts(): OfflineTts {
    tts?.let {
      LogStore.write(TAG, "ensureTts reused existing model")
      return it
    }

    LogStore.write(TAG, "ensureTts checking assets")
    assertAsset("$MODEL_DIR/model.onnx")
    assertAsset("$MODEL_DIR/voices.bin")
    assertAsset("$MODEL_DIR/tokens.txt")

    val dataDirAsset = "$MODEL_DIR/espeak-ng-data"
    LogStore.write(TAG, "ensureTts copying data dir $dataDirAsset")
    val dataRoot = copyDataDir(dataDirAsset)
    LogStore.write(TAG, "ensureTts copied data root $dataRoot")
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
    LogStore.write(TAG, "ensureTts creating OfflineTts")
    return OfflineTts(assetManager = reactContext.assets, config = config).also {
      tts = it
      LogStore.write(TAG, "ensureTts created sampleRate=${it.sampleRate()} speakers=${it.numSpeakers()}")
    }
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
    ).also {
      track = it
      LogStore.write(TAG, "created AudioTrack sampleRate=$sampleRate minBufferSize=$minBufferSize")
    }
  }

  private fun assertAsset(path: String) {
    try {
      reactContext.assets.open(path).use { }
      LogStore.write(TAG, "asset ok $path")
    } catch (e: IOException) {
      LogStore.write(TAG, "asset missing $path")
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

private fun String.wordCount(): Int =
  trim().split(Regex("\\s+")).count { it.isNotBlank() }
