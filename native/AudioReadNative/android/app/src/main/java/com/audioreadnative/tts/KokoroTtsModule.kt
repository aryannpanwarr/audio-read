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
import java.util.LinkedHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import kotlin.math.max

private const val TAG = "AudioReadKokoro"
private const val MODEL_DIR = "kokoro-en-v0_19"

class KokoroTtsModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  private val executor = Executors.newSingleThreadExecutor()
  private val synthExecutor = Executors.newSingleThreadExecutor()
  private var tts: OfflineTts? = null
  private var track: AudioTrack? = null
  private val audioCache = object : LinkedHashMap<String, GeneratedAudio>(4, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, GeneratedAudio>?): Boolean = size > 3
  }
  private val inFlightAudio = mutableMapOf<String, Future<GeneratedAudio>>()
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
  fun speak(text: String, speakerId: Int, speed: Double, nextText: String?, promise: Promise) {
    LogStore.write(
      TAG,
      "speak requested chars=${text.length} nextChars=${nextText?.length ?: 0} speakerId=$speakerId speed=$speed",
    )
    executor.execute {
      try {
        val cleanText = text.trim()
        if (cleanText.isEmpty()) {
          promise.reject("EMPTY_TEXT", "Enter text before speaking")
          return@execute
        }
        val callStart = System.nanoTime()
        val audio = getOrGenerateAudio(cleanText, speakerId, speed)
        val audioTrack = ensureAudioTrack(audio.sampleRate)
        val waitSeconds = (System.nanoTime() - callStart) / 1_000_000_000.0
        startPrefetch(nextText, speakerId, speed)

        stopped = false
        audioTrack.pause()
        audioTrack.flush()
        audioTrack.play()

        LogStore.write(
          TAG,
          "speak timing before-playback generation=${"%.3f".format(audio.generationSeconds)}s wait=${"%.3f".format(waitSeconds)}s audio=${"%.3f".format(audio.audioDurationSeconds)}s rtf=${"%.3f".format(audio.rtf)} source=${audio.source} samples=${audio.samples.size}",
        )
        if (!stopped && audio.samples.isNotEmpty()) {
          emitSpeechTiming(audio.audioDurationSeconds, cleanText.wordCount())
          val playbackStart = System.nanoTime()
          LogStore.write(TAG, "speak writing ${audio.samples.size} samples to AudioTrack")
          audioTrack.write(audio.samples, 0, audio.samples.size, AudioTrack.WRITE_BLOCKING)
          val playbackSeconds = (System.nanoTime() - playbackStart) / 1_000_000_000.0
          val totalSeconds = (System.nanoTime() - callStart) / 1_000_000_000.0
          LogStore.write(
            TAG,
            "speak finished playback write=${"%.3f".format(playbackSeconds)}s total=${"%.3f".format(totalSeconds)}s audio=${"%.3f".format(audio.audioDurationSeconds)}s generation=${"%.3f".format(audio.generationSeconds)}s source=${audio.source}",
          )
        }

        val map = Arguments.createMap()
        map.putDouble("elapsedSeconds", audio.generationSeconds)
        map.putDouble("audioDurationSeconds", audio.audioDurationSeconds)
        map.putDouble("rtf", audio.rtf)
        map.putInt("sampleRate", audio.sampleRate)
        map.putInt("samples", audio.samples.size)
        map.putBoolean("cached", audio.source != "fresh")
        map.putString("source", audio.source)
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
    stopped = true
    try {
      track?.pause()
      track?.flush()
      LogStore.write(TAG, "stop resolved")
      promise.resolve(null)
    } catch (e: Throwable) {
      LogStore.write(TAG, "stop failed: ${e.stackTraceToString()}")
      promise.reject("KOKORO_STOP_FAILED", e.message, e)
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
    synthExecutor.shutdownNow()
    super.invalidate()
  }

  private fun getOrGenerateAudio(text: String, speakerId: Int, speed: Double): GeneratedAudio {
    val key = audioKey(text, speakerId, speed)
    synchronized(audioCache) {
      audioCache.remove(key)?.let {
        LogStore.write(TAG, "speak cache hit chars=${text.length}")
        return it.copy(source = "cache")
      }
    }
    val future = synchronized(audioCache) {
      inFlightAudio[key] ?: synthExecutor.submit<GeneratedAudio> {
        generateAudio(text, speakerId, speed, source = "fresh")
      }.also { inFlightAudio[key] = it }
    }
    val generated = future.get()
    synchronized(audioCache) {
      inFlightAudio.remove(key)
      audioCache.remove(key)
    }
    return generated.copy(source = if (generated.source == "prefetch") "in-flight" else generated.source)
  }

  private fun startPrefetch(nextText: String?, speakerId: Int, speed: Double) {
    val cleanNext = nextText?.trim().orEmpty()
    if (cleanNext.isEmpty()) return
    val key = audioKey(cleanNext, speakerId, speed)
    val future = synchronized(audioCache) {
      if (audioCache.containsKey(key) || inFlightAudio.containsKey(key)) return
      synthExecutor.submit<GeneratedAudio> {
        LogStore.write(TAG, "prefetch generating chars=${cleanNext.length}")
        generateAudio(cleanNext, speakerId, speed, source = "prefetch")
      }.also { inFlightAudio[key] = it }
    }
    synthExecutor.execute {
      try {
        val generated = future.get()
        synchronized(audioCache) {
          inFlightAudio.remove(key)
          audioCache[key] = generated
        }
        LogStore.write(
          TAG,
          "prefetch resolved generation=${"%.3f".format(generated.generationSeconds)}s audio=${"%.3f".format(generated.audioDurationSeconds)}s rtf=${"%.3f".format(generated.rtf)} samples=${generated.samples.size}",
        )
      } catch (e: Throwable) {
        LogStore.write(TAG, "prefetch failed: ${e.message}")
      }
    }
  }

  private fun generateAudio(text: String, speakerId: Int, speed: Double, source: String): GeneratedAudio {
    val model = ensureTts()
    val start = System.nanoTime()
    val audio = model.generateWithConfig(
      text = text,
      config = GenerationConfig(
        sid = max(0, speakerId),
        speed = speed.toFloat().coerceIn(0.5f, 2.0f),
        silenceScale = 0.2f,
      ),
    )
    val generationSeconds = (System.nanoTime() - start) / 1_000_000_000.0
    val audioDuration = audio.samples.size.toDouble() / audio.sampleRate.toDouble()
    val rtf = if (audioDuration > 0.0) generationSeconds / audioDuration else 0.0
    return GeneratedAudio(
      samples = audio.samples,
      sampleRate = audio.sampleRate,
      generationSeconds = generationSeconds,
      audioDurationSeconds = audioDuration,
      rtf = rtf,
      source = source,
    )
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

  @Synchronized
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

  private fun audioKey(text: String, speakerId: Int, speed: Double): String =
    "${max(0, speakerId)}|${speed.toFloat().coerceIn(0.5f, 2.0f)}|$text"

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

private data class GeneratedAudio(
  val samples: FloatArray,
  val sampleRate: Int,
  val generationSeconds: Double,
  val audioDurationSeconds: Double,
  val rtf: Double,
  val source: String,
)

private fun String.wordCount(): Int =
  trim().split(Regex("\\s+")).count { it.isNotBlank() }
