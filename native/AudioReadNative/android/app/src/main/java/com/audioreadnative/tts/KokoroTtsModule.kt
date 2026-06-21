package com.audioreadnative.tts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.audioreadnative.AudioReadPlaybackService
import com.audioreadnative.MainActivity
import com.audioreadnative.PLAYBACK_COMMAND_ACTION
import com.audioreadnative.PLAYBACK_COMMAND_EXTRA
import androidx.core.content.FileProvider
import com.audioreadnative.LogStore
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.getOfflineTtsConfig
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.LinkedHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.max

private const val TAG = "AudioReadKokoro"
private const val MODEL_DIR = "kokoro-en-v0_19"
private const val MAX_CACHED_AUDIO_SECONDS = 1_200.0
private const val MAX_DISK_CACHED_AUDIO_SECONDS = 7_200.0
private const val PREP_CHANNEL_ID = "audio_read_preparation"
private const val PREP_NOTIFICATION_ID = 1307

class KokoroTtsModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  private val executor = Executors.newSingleThreadExecutor()
  private val synthExecutor = Executors.newSingleThreadExecutor()
  private var tts: OfflineTts? = null
  private var track: AudioTrack? = null
  private val generationLock = Any()
  private var cachedAudioSeconds = 0.0
  private val audioCache = object : LinkedHashMap<String, GeneratedAudio>(4, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, GeneratedAudio>?): Boolean {
      if (cachedAudioSeconds <= MAX_CACHED_AUDIO_SECONDS) return false
      eldest?.value?.let { cachedAudioSeconds -= it.audioDurationSeconds }
      return true
    }
  }
  private val prebufferEpoch = AtomicInteger(0)
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
    prebufferEpoch.incrementAndGet()
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
  fun prebuffer(texts: ReadableArray, speakerId: Int, speed: Double, targetAudioSeconds: Double, promise: Promise) {
    val items = mutableListOf<String>()
    for (index in 0 until texts.size()) {
      texts.getString(index)?.trim()?.takeIf { it.isNotEmpty() }?.let { items.add(it) }
    }
    LogStore.write(
      TAG,
      "prebuffer requested items=${items.size} targetAudio=${"%.1f".format(targetAudioSeconds)} speakerId=$speakerId speed=$speed",
    )
    stopped = false
    val runEpoch = prebufferEpoch.incrementAndGet()
    synthExecutor.execute {
      val startedAt = System.nanoTime()
      var generatedCount = 0
      var generatedAudioSeconds = 0.0
      var cacheHits = 0
      try {
        for ((index, text) in items.withIndex()) {
          if (stopped || runEpoch != prebufferEpoch.get()) break
          if (generatedAudioSeconds >= targetAudioSeconds) break
          val key = audioKey(text, speakerId, speed)
          val cached = synchronized(audioCache) { audioCache[key] }
          if (cached != null) {
            cacheHits += 1
            generatedAudioSeconds += cached.audioDurationSeconds
            emitPrebufferProgress(index + 1, items.size, generatedAudioSeconds, startedAt, cacheHits)
            continue
          }
          val disk = loadDiskAudio(key)
          if (disk != null) {
            synchronized(audioCache) {
              putAudioCacheLocked(key, disk.copy(source = "disk-prebuffer"))
            }
            cacheHits += 1
            generatedAudioSeconds += disk.audioDurationSeconds
            emitPrebufferProgress(index + 1, items.size, generatedAudioSeconds, startedAt, cacheHits)
            continue
          }
          val generated = synchronized(generationLock) {
            if (stopped || runEpoch != prebufferEpoch.get()) null
            else generateAudio(text, speakerId, speed, source = "prebuffer")
          } ?: break
          synchronized(audioCache) {
            putAudioCacheLocked(key, generated)
          }
          saveDiskAudio(key, generated)
          generatedCount += 1
          generatedAudioSeconds += generated.audioDurationSeconds
          LogStore.write(
            TAG,
            "prebuffer item=${index + 1}/${items.size} generation=${"%.3f".format(generated.generationSeconds)}s audio=${"%.3f".format(generated.audioDurationSeconds)}s totalAudio=${"%.3f".format(generatedAudioSeconds)}s cacheSeconds=${"%.3f".format(cachedAudioSeconds)}",
          )
          emitPrebufferProgress(index + 1, items.size, generatedAudioSeconds, startedAt, cacheHits)
        }
        val elapsed = (System.nanoTime() - startedAt) / 1_000_000_000.0
        LogStore.write(
          TAG,
          "prebuffer resolved generated=$generatedCount cacheHits=$cacheHits audio=${"%.3f".format(generatedAudioSeconds)}s elapsed=${"%.3f".format(elapsed)}s",
        )
        val map = Arguments.createMap().apply {
          putInt("generated", generatedCount)
          putInt("cacheHits", cacheHits)
          putDouble("audioDurationSeconds", generatedAudioSeconds)
          putDouble("elapsedSeconds", elapsed)
        }
        promise.resolve(map)
      } catch (e: Throwable) {
        LogStore.write(TAG, "prebuffer failed: ${e.stackTraceToString()}")
        promise.reject("KOKORO_PREBUFFER_FAILED", e.message, e)
      }
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
  fun notifyPreparationDone(title: String, audioDurationSeconds: Double, promise: Promise) {
    try {
      createPreparationChannel()
      val openIntent = Intent(reactContext, MainActivity::class.java)
      val pendingIntent = PendingIntent.getActivity(
        reactContext,
        0,
        openIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val notification = Notification.Builder(reactContext, PREP_CHANNEL_ID)
        .setContentTitle("Audio Read is ready")
        .setContentText("${title.take(42)} · ${formatDurationForNotification(audioDurationSeconds)} prepared")
        .setSmallIcon(android.R.drawable.ic_media_play)
        .setContentIntent(pendingIntent)
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .build()
      val manager = reactContext.getSystemService(NotificationManager::class.java)
      manager.notify(PREP_NOTIFICATION_ID, notification)
      LogStore.write(TAG, "notifyPreparationDone title=$title audio=${"%.3f".format(audioDurationSeconds)}")
      promise.resolve(null)
    } catch (e: Throwable) {
      LogStore.write(TAG, "notifyPreparationDone failed: ${e.stackTraceToString()}")
      promise.reject("PREPARATION_NOTIFY_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun requestBackgroundPlaybackPermission(promise: Promise) {
    try {
      val powerManager = reactContext.getSystemService(PowerManager::class.java)
      if (powerManager.isIgnoringBatteryOptimizations(reactContext.packageName)) {
        LogStore.write(TAG, "background permission already unrestricted")
        promise.resolve(false)
        return
      }
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${reactContext.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
      LogStore.write(TAG, "background permission prompt opened")
      promise.resolve(true)
    } catch (e: Throwable) {
      LogStore.write(TAG, "background permission prompt failed: ${e.stackTraceToString()}")
      promise.reject("BACKGROUND_PERMISSION_FAILED", e.message, e)
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
    loadDiskAudio(key)?.let {
      LogStore.write(TAG, "speak disk cache hit chars=${text.length}")
      synchronized(audioCache) {
        putAudioCacheLocked(key, it)
      }
      return it.copy(source = "disk")
    }
    prebufferEpoch.incrementAndGet()
    val generated = synchronized(generationLock) {
      val cachedAfterWait = synchronized(audioCache) { audioCache.remove(key) }
      if (cachedAfterWait != null) {
        LogStore.write(TAG, "speak cache hit after wait chars=${text.length}")
        cachedAfterWait.copy(source = "cache-after-wait")
      } else {
        val diskAfterWait = loadDiskAudio(key)
        if (diskAfterWait != null) {
          LogStore.write(TAG, "speak disk cache hit after wait chars=${text.length}")
          synchronized(audioCache) {
            putAudioCacheLocked(key, diskAfterWait)
          }
          diskAfterWait.copy(source = "disk-after-wait")
        } else {
          generateAudio(text, speakerId, speed, source = "fresh")
        }
      }
    }
    synchronized(audioCache) {
      audioCache.remove(key)
      cachedAudioSeconds = audioCache.values.sumOf { it.audioDurationSeconds }
    }
    saveDiskAudio(key, generated)
    return generated
  }

  private fun generateAudio(text: String, speakerId: Int, speed: Double, source: String): GeneratedAudio {
    val model = ensureTts()
    val start = System.nanoTime()
    val audio = model.generateWithConfig(
      text = text,
      config = GenerationConfig(
        sid = max(0, speakerId),
        speed = speed.toFloat().coerceIn(0.5f, 2.0f),
        silenceScale = 0.32f,
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

  private fun emitPrebufferProgress(
    processed: Int,
    total: Int,
    audioSeconds: Double,
    startedAt: Long,
    cacheHits: Int,
  ) {
    val elapsed = (System.nanoTime() - startedAt) / 1_000_000_000.0
    val map = Arguments.createMap().apply {
      putInt("processed", processed)
      putInt("total", total)
      putInt("cacheHits", cacheHits)
      putDouble("audioDurationSeconds", audioSeconds)
      putDouble("elapsedSeconds", elapsed)
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AudioReadPrebufferProgress", map)
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

  private fun putAudioCacheLocked(key: String, audio: GeneratedAudio) {
    audioCache.remove(key)?.let { cachedAudioSeconds -= it.audioDurationSeconds }
    audioCache[key] = audio
    cachedAudioSeconds += audio.audioDurationSeconds
    while (cachedAudioSeconds > MAX_CACHED_AUDIO_SECONDS && audioCache.isNotEmpty()) {
      val eldestKey = audioCache.entries.first().key
      val removed = audioCache.remove(eldestKey)
      if (removed != null) cachedAudioSeconds -= removed.audioDurationSeconds
    }
  }

  private fun diskCacheDir(): File = File(reactContext.filesDir, "audio-cache").also { it.mkdirs() }

  private fun diskCacheFile(key: String): File = File(diskCacheDir(), "${sha256(key)}.pcm")

  private fun loadDiskAudio(key: String): GeneratedAudio? {
    val file = diskCacheFile(key)
    if (!file.exists() || file.length() <= 0L) return null
    return try {
      DataInputStream(BufferedInputStream(file.inputStream())).use { input ->
        val version = input.readInt()
        if (version != 1) return null
        val sampleRate = input.readInt()
        val audioDurationSeconds = input.readDouble()
        val sampleCount = input.readInt()
        if (sampleCount <= 0) return null
        val samples = FloatArray(sampleCount)
        for (index in 0 until sampleCount) {
          samples[index] = input.readFloat()
        }
        file.setLastModified(System.currentTimeMillis())
        GeneratedAudio(
          samples = samples,
          sampleRate = sampleRate,
          generationSeconds = 0.0,
          audioDurationSeconds = audioDurationSeconds,
          rtf = 0.0,
          source = "disk",
        )
      }
    } catch (e: Throwable) {
      LogStore.write(TAG, "disk cache read failed ${file.name}: ${e.message}")
      file.delete()
      null
    }
  }

  private fun saveDiskAudio(key: String, audio: GeneratedAudio) {
    try {
      val file = diskCacheFile(key)
      DataOutputStream(BufferedOutputStream(file.outputStream())).use { output ->
        output.writeInt(1)
        output.writeInt(audio.sampleRate)
        output.writeDouble(audio.audioDurationSeconds)
        output.writeInt(audio.samples.size)
        audio.samples.forEach { output.writeFloat(it) }
      }
      trimDiskCache()
    } catch (e: Throwable) {
      LogStore.write(TAG, "disk cache write failed: ${e.message}")
    }
  }

  private fun trimDiskCache() {
    val files = diskCacheDir()
      .listFiles { file -> file.isFile && file.extension == "pcm" }
      ?.sortedBy { it.lastModified() }
      ?: return
    var totalSeconds = files.sumOf { file -> readDiskAudioDuration(file) ?: 0.0 }
    for (file in files) {
      if (totalSeconds <= MAX_DISK_CACHED_AUDIO_SECONDS) break
      val seconds = readDiskAudioDuration(file) ?: 0.0
      if (file.delete()) totalSeconds -= seconds
    }
  }

  private fun readDiskAudioDuration(file: File): Double? =
    try {
      DataInputStream(BufferedInputStream(file.inputStream())).use { input ->
        val version = input.readInt()
        input.readInt()
        if (version == 1) input.readDouble() else null
      }
    } catch (_: Throwable) {
      null
    }

  private fun sha256(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
    return digest.joinToString("") { "%02x".format(it) }
  }

  private fun createPreparationChannel() {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) return
    val manager = reactContext.getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      PREP_CHANNEL_ID,
      "Audio Read preparation",
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "Notifies when document audio preparation is ready"
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
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

private data class GeneratedAudio(
  val samples: FloatArray,
  val sampleRate: Int,
  val generationSeconds: Double,
  val audioDurationSeconds: Double,
  val rtf: Double,
  val source: String,
)

private fun formatDurationForNotification(seconds: Double): String {
  val totalSeconds = seconds.toInt().coerceAtLeast(0)
  val minutes = totalSeconds / 60
  val remainingSeconds = totalSeconds % 60
  return "${minutes}m ${remainingSeconds}s"
}

private fun String.wordCount(): Int =
  trim().split(Regex("\\s+")).count { it.isNotBlank() }
