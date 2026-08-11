package com.audioreadnative.tts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.audioreadnative.AudioReadPlaybackService
import com.audioreadnative.LogStore
import com.audioreadnative.MainActivity
import com.audioreadnative.PLAYBACK_COMMAND_ACTION
import com.audioreadnative.PLAYBACK_COMMAND_EXTRA
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max

private const val TAG = "AudioReadSystemTts"
private const val PREP_CHANNEL_ID = "audio_read_preparation"
private const val PREP_NOTIFICATION_ID = 1307

class SystemTtsModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), TextToSpeech.OnInitListener {
  private var tts: TextToSpeech? = null
  @Volatile private var ready = false
  @Volatile private var initStarted = false
  private val initPromises = mutableListOf<Promise>()
  private val initCallbacks = mutableListOf<InitCallback>()
  private val utterances = ConcurrentHashMap<String, UtteranceState>()

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

  override fun getName() = "SystemTts"

  override fun onInit(status: Int) {
    if (status == TextToSpeech.SUCCESS) {
      val engine = tts
      ready = true
      engine?.let { setDefaultEnglishVoice(it) }
      engine?.setOnUtteranceProgressListener(listener)
      LogStore.write(TAG, "system tts initialized engine=${engine?.defaultEngine} voice=${engine?.voice?.name}")
      val result = systemInfo()
      synchronized(initPromises) {
        initPromises.forEach { it.resolve(result) }
        initPromises.clear()
      }
      synchronized(initCallbacks) {
        initCallbacks.forEach { it.onReady() }
        initCallbacks.clear()
      }
    } else {
      val error = IllegalStateException("Android system TTS failed to initialize: $status")
      LogStore.write(TAG, "system tts init failed status=$status")
      synchronized(initPromises) {
        initPromises.forEach { it.reject("SYSTEM_TTS_INIT_FAILED", error.message, error) }
        initPromises.clear()
      }
      synchronized(initCallbacks) {
        initCallbacks.forEach { it.onError(error) }
        initCallbacks.clear()
      }
    }
  }

  @ReactMethod
  fun initialize(promise: Promise) {
    LogStore.write(TAG, "initialize requested")
    if (ready) {
      promise.resolve(systemInfo())
      return
    }
    synchronized(initPromises) {
      initPromises.add(promise)
      if (!initStarted) {
        initStarted = true
        tts = TextToSpeech(reactContext, this)
      }
    }
  }

  @ReactMethod
  fun speak(text: String, voiceName: String?, speed: Double, promise: Promise) {
    val cleanText = text.trim()
    if (cleanText.isEmpty()) {
      promise.reject("EMPTY_TEXT", "No text to read")
      return
    }
    initializeThen(
      onReady = {
        val engine = tts ?: run {
          promise.reject("SYSTEM_TTS_UNAVAILABLE", "Android system TTS is not available")
          return@initializeThen
        }
        val utteranceId = UUID.randomUUID().toString()
        val startedAt = System.nanoTime()
        val estimatedDuration = estimateDurationSeconds(cleanText, speed)
        utterances[utteranceId] = UtteranceState(promise, startedAt, estimatedDuration, cleanText.wordCount(), cleanText)
        engine.setSpeechRate(speed.toFloat().coerceIn(0.5f, 2.0f))
        selectVoice(engine, voiceName)
        emitSpeechTiming(estimatedDuration, cleanText.wordCount())
        val result = engine.speak(cleanText, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
        if (result == TextToSpeech.ERROR) {
          utterances.remove(utteranceId)
          promise.reject("SYSTEM_TTS_SPEAK_FAILED", "Android system TTS rejected the utterance")
        } else {
          LogStore.write(TAG, "speak started chars=${cleanText.length} words=${cleanText.wordCount()} speed=$speed voice=${engine.voice?.name.orEmpty()}")
        }
      },
      onError = { error -> promise.reject("SYSTEM_TTS_INIT_FAILED", error.message, error) },
    )
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      LogStore.write(TAG, "stop requested")
      tts?.stop()
      promise.resolve(null)
    } catch (e: Throwable) {
      LogStore.write(TAG, "stop failed: ${e.stackTraceToString()}")
      promise.reject("SYSTEM_TTS_STOP_FAILED", e.message, e)
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
  fun updateNowPlaying(
    title: String,
    subtitle: String,
    isPlaying: Boolean,
    elapsedSeconds: Double,
    totalSeconds: Double,
    promise: Promise,
  ) {
    try {
      ContextCompat.startForegroundService(
        reactContext,
        AudioReadPlaybackService.updateIntent(
          reactContext,
          title,
          subtitle,
          isPlaying,
          (elapsedSeconds * 1000).toLong().coerceAtLeast(0L),
          (totalSeconds * 1000).toLong().coerceAtLeast(0L),
        ),
      )
      promise.resolve(null)
    } catch (e: Throwable) {
      LogStore.write(TAG, "updateNowPlaying failed: ${e.stackTraceToString()}")
      promise.reject("PLAYBACK_UPDATE_FAILED", e.message, e)
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
  fun requestBackgroundPlaybackPermission(promise: Promise) {
    try {
      val powerManager = reactContext.getSystemService(PowerManager::class.java)
      if (powerManager.isIgnoringBatteryOptimizations(reactContext.packageName)) {
        LogStore.write(TAG, "background permission already unrestricted")
        promise.resolve(false)
        return
      }
      // ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS opens the same settings screen
      // without needing the REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission, which
      // Play restricts to a narrow set of use cases. Costs the user one extra tap.
      val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
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
  fun notifyPreparationDone(title: String, audioDurationSeconds: Double, promise: Promise) {
    try {
      createPreparationChannel()
      val pendingIntent = PendingIntent.getActivity(
        reactContext,
        0,
        Intent(reactContext, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val notification = Notification.Builder(reactContext, PREP_CHANNEL_ID)
        .setContentTitle("Audio Read")
        .setContentText(title.take(42))
        .setSmallIcon(android.R.drawable.ic_media_play)
        .setContentIntent(pendingIntent)
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .build()
      reactContext.getSystemService(NotificationManager::class.java).notify(PREP_NOTIFICATION_ID, notification)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("NOTIFY_FAILED", e.message, e)
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
    try {
      reactContext.unregisterReceiver(commandReceiver)
    } catch (_: Throwable) {
    }
    tts?.stop()
    tts?.shutdown()
    tts = null
    utterances.clear()
    super.invalidate()
  }

  private fun initializeThen(onReady: () -> Unit, onError: (Throwable) -> Unit) {
    if (ready) {
      onReady()
      return
    }
    synchronized(initCallbacks) {
      initCallbacks.add(InitCallback(onReady, onError))
      if (!initStarted) {
        initStarted = true
        tts = TextToSpeech(reactContext, this)
      }
    }
  }

  private val listener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) = Unit

    // Exact per-word callback (API 26+): start/end are char offsets into the spoken text,
    // letting the UI highlight the precise word being read (word-level tracking).
    override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
      val state = utteranceId?.let { utterances[it] }
      if (state != null) {
        state.rangeCount++
        val word = if (start in 0..state.text.length && end in start..state.text.length) {
          state.text.substring(start, end)
        } else {
          "?"
        }
        // First few words per utterance only, so logs stay readable but prove ranges fire.
        if (state.rangeCount <= 6) {
          LogStore.write(TAG, "range #${state.rangeCount} start=$start end=$end word=\"$word\"")
        }
      } else {
        LogStore.write(TAG, "range start=$start end=$end (no utterance state)")
      }
      emitSpeechRange(start, end)
    }

    override fun onDone(utteranceId: String?) {
      val id = utteranceId ?: return
      val state = utterances.remove(id) ?: return
      LogStore.write(TAG, "speak done id=$id ranges=${state.rangeCount} words=${state.wordCount}")
      state.promise.resolve(state.resultMap("system"))
    }

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String?) {
      onError(utteranceId, TextToSpeech.ERROR)
    }

    override fun onError(utteranceId: String?, errorCode: Int) {
      val id = utteranceId ?: return
      val state = utterances.remove(id) ?: return
      LogStore.write(TAG, "speak error id=$id code=$errorCode")
      state.promise.reject("SYSTEM_TTS_SPEAK_FAILED", "Android system TTS failed with code $errorCode")
    }

    override fun onStop(utteranceId: String?, interrupted: Boolean) {
      val id = utteranceId ?: return
      val state = utterances.remove(id) ?: return
      LogStore.write(TAG, "speak stopped id=$id interrupted=$interrupted")
      state.promise.resolve(state.resultMap("stopped"))
    }
  }

  private fun systemInfo() = Arguments.createMap().apply {
    val engine = tts
    putInt("sampleRate", 0)
    putInt("speakers", engine?.voices?.size ?: 0)
    putString("model", "Android System TTS")
    putString("engine", engine?.defaultEngine ?: "")
    val voices = Arguments.createArray()
    val allEnglish = engine?.voices
      ?.filter { it.locale.language.equals("en", ignoreCase = true) && !it.isUnusableVoice() }
      .orEmpty()
    // The app ships without INTERNET permission, so network voices cannot speak.
    // Show local English voices; only fall back to network voices if no local ones exist.
    val localEnglish = allEnglish.filter { !it.isNetworkConnectionRequired }
    val englishVoices = (if (localEnglish.isNotEmpty()) localEnglish else allEnglish)
      .sortedWith(
        // en-US first, local before network, higher quality first, then stable by name
        compareBy(
          { !it.locale.country.equals("US", ignoreCase = true) },
          { it.isNetworkConnectionRequired },
          { -it.quality },
          { it.locale.toLanguageTag() },
          { it.name },
        ),
      )
    englishVoices.forEach { voice ->
      voices.pushMap(Arguments.createMap().apply {
        putString("name", voice.name)
        putString("locale", voice.locale.toLanguageTag())
        putString("label", voiceLabel(voice.locale, voice.name))
        putInt("quality", voice.quality)
        putBoolean("requiresNetwork", voice.isNetworkConnectionRequired)
        putBoolean("isLocal", !voice.isNetworkConnectionRequired)
      })
    }
    LogStore.write(TAG, "systemInfo englishVoices=${englishVoices.size} local=${englishVoices.count { !it.isNetworkConnectionRequired }}")
    putArray("voices", voices)
  }

  private fun selectVoice(engine: TextToSpeech, voiceName: String?) {
    if (voiceName.isNullOrBlank()) {
      setDefaultEnglishVoice(engine)
      return
    }
    engine.voices?.firstOrNull { it.name == voiceName }?.let { engine.voice = it } ?: setDefaultEnglishVoice(engine)
  }

  private fun setDefaultEnglishVoice(engine: TextToSpeech) {
    val all = engine.voices.orEmpty().filterNot { it.isUnusableVoice() }
    val local = all.filter { !it.isNetworkConnectionRequired }
    // Prefer a local en-US voice, then any local English, then any English voice at all.
    val preferred = local.firstOrNull { it.locale.country.equals("US", ignoreCase = true) && it.locale.language.equals("en", ignoreCase = true) }
      ?: local.firstOrNull { it.locale.language.equals("en", ignoreCase = true) }
      ?: all.firstOrNull { it.locale.country.equals("US", ignoreCase = true) && it.locale.language.equals("en", ignoreCase = true) }
      ?: all.firstOrNull { it.locale.language.equals("en", ignoreCase = true) }
    if (preferred != null) {
      engine.voice = preferred
      engine.language = preferred.locale
      LogStore.write(TAG, "default voice selected name=${preferred.name} locale=${preferred.locale.toLanguageTag()} network=${preferred.isNetworkConnectionRequired}")
    } else {
      engine.language = Locale.US
      LogStore.write(TAG, "default voice fallback to Locale.US")
    }
  }

  private fun emitPlaybackCommand(command: String) {
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AudioReadPlaybackCommand", command)
  }

  private fun emitSpeechRange(start: Int, end: Int) {
    val map = Arguments.createMap().apply {
      putInt("start", start)
      putInt("end", end)
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AudioReadSpeechRange", map)
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

  private fun createPreparationChannel() {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) return
    val manager = reactContext.getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      PREP_CHANNEL_ID,
      "Audio Read",
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "Audio Read notifications"
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }
}

private data class UtteranceState(
  val promise: Promise,
  val startedAt: Long,
  val estimatedAudioDurationSeconds: Double,
  val wordCount: Int,
  val text: String = "",
  var rangeCount: Int = 0,
) {
  fun resultMap(source: String) = Arguments.createMap().apply {
    val elapsed = (System.nanoTime() - startedAt) / 1_000_000_000.0
    putDouble("elapsedSeconds", elapsed)
    putDouble("audioDurationSeconds", estimatedAudioDurationSeconds)
    putDouble("rtf", 0.0)
    putInt("sampleRate", 0)
    putInt("samples", 0)
    putString("source", source)
    putInt("wordCount", wordCount)
  }
}

private data class InitCallback(
  val onReady: () -> Unit,
  val onError: (Throwable) -> Unit,
)

private fun estimateDurationSeconds(text: String, speed: Double): Double {
  val words = max(1, text.wordCount())
  val wordsPerSecond = (165.0 / 60.0) * speed.coerceIn(0.5, 2.0)
  return words / wordsPerSecond
}

private fun String.wordCount(): Int =
  trim().split(Regex("\\s+")).count { it.isNotBlank() }

private fun android.speech.tts.Voice.isUnusableVoice(): Boolean {
  if (quality < android.speech.tts.Voice.QUALITY_VERY_LOW) return true
  val features = features ?: return false
  return features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
}

private fun voiceLabel(locale: Locale, name: String): String {
  val language = locale.getDisplayLanguage(Locale.US).ifBlank { locale.language }
  val country = when {
    locale.country.isBlank() -> ""
    else -> " (${locale.country.uppercase(Locale.US)})"
  }
  // Pull a short, human-ish variant tag from the engine voice name, e.g.
  // "en-us-x-sfg-local" -> "sfg", "en-US-language" -> "language".
  val variant = name
    .substringAfterLast("-x-", name.substringAfterLast('-', ""))
    .removeSuffix("-local")
    .removeSuffix("-network")
    .ifBlank { "default" }
  return "$language$country · $variant"
}
