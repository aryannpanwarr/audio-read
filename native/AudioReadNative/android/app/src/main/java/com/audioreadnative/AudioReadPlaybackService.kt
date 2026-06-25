package com.audioreadnative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder

private const val CHANNEL_ID = "audio_read_playback"
private const val NOTIFICATION_ID = 1207
private const val ACTION_START = "com.audioreadnative.playback.START"
private const val ACTION_STOP = "com.audioreadnative.playback.STOP"
private const val ACTION_UPDATE = "com.audioreadnative.playback.UPDATE"
const val PLAYBACK_COMMAND_ACTION = "com.audioreadnative.playback.COMMAND"
const val PLAYBACK_COMMAND_EXTRA = "command"
const val PLAYBACK_COMMAND_PAUSE = "pause"
const val PLAYBACK_COMMAND_PREVIOUS = "previous"
const val PLAYBACK_COMMAND_NEXT = "next"

private const val EXTRA_TITLE = "title"
private const val EXTRA_SUBTITLE = "subtitle"
private const val EXTRA_PLAYING = "playing"
private const val EXTRA_ELAPSED_MS = "elapsedMs"
private const val EXTRA_DURATION_MS = "durationMs"

class AudioReadPlaybackService : Service() {
  private var mediaSession: MediaSession? = null

  // Last known now-playing state, kept so every notification rebuild (start/update)
  // renders a Spotify-style card with the right title, progress and play/pause icon.
  private var title: String = "Audio Read"
  private var subtitle: String = "Reading with Android system voice"
  private var playing: Boolean = true
  private var elapsedMs: Long = 0L
  private var durationMs: Long = 0L

  override fun onCreate() {
    super.onCreate()
    createChannel()
    setupMediaSession()
    LogStore.write("playback-service", "created")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    return when (intent?.action) {
      ACTION_STOP -> {
        LogStore.write("playback-service", "stop requested")
        stopForegroundCompat()
        stopSelf()
        START_NOT_STICKY
      }
      else -> {
        readState(intent)
        updateMediaSession()
        startForeground(NOTIFICATION_ID, notification())
        START_STICKY
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    mediaSession?.let {
      it.isActive = false
      it.release()
    }
    mediaSession = null
    LogStore.write("playback-service", "destroyed")
    super.onDestroy()
  }

  private fun readState(intent: Intent?) {
    intent ?: return
    intent.getStringExtra(EXTRA_TITLE)?.let { if (it.isNotBlank()) title = it }
    intent.getStringExtra(EXTRA_SUBTITLE)?.let { subtitle = it }
    if (intent.hasExtra(EXTRA_PLAYING)) playing = intent.getBooleanExtra(EXTRA_PLAYING, true)
    if (intent.hasExtra(EXTRA_ELAPSED_MS)) elapsedMs = intent.getLongExtra(EXTRA_ELAPSED_MS, 0L)
    if (intent.hasExtra(EXTRA_DURATION_MS)) durationMs = intent.getLongExtra(EXTRA_DURATION_MS, 0L)
  }

  // A platform MediaSession turns the notification into a real media card and makes
  // lock-screen, Bluetooth and wired-headset transport buttons drive playback too.
  private fun setupMediaSession() {
    val session = MediaSession(this, "AudioRead")
    session.setCallback(object : MediaSession.Callback() {
      // JS owns a single play/pause toggle, so both map to the same command.
      override fun onPlay() = broadcastCommand(PLAYBACK_COMMAND_PAUSE)
      override fun onPause() = broadcastCommand(PLAYBACK_COMMAND_PAUSE)
      override fun onSkipToNext() = broadcastCommand(PLAYBACK_COMMAND_NEXT)
      override fun onSkipToPrevious() = broadcastCommand(PLAYBACK_COMMAND_PREVIOUS)
      override fun onStop() {
        startService(stopIntent(this@AudioReadPlaybackService))
      }
    })
    session.isActive = true
    mediaSession = session
  }

  private fun broadcastCommand(command: String) {
    sendBroadcast(
      Intent(PLAYBACK_COMMAND_ACTION)
        .setPackage(packageName)
        .putExtra(PLAYBACK_COMMAND_EXTRA, command),
    )
  }

  private fun updateMediaSession() {
    val session = mediaSession ?: return
    session.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, title)
        .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
        .putString(MediaMetadata.METADATA_KEY_ALBUM, "Audio Read")
        .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
        .build(),
    )
    val state = if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or
            PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or
            PlaybackState.ACTION_SKIP_TO_PREVIOUS or
            PlaybackState.ACTION_STOP,
        )
        // Reporting the playback speed lets Android animate the scrubber between updates.
        .setState(state, elapsedMs, if (playing) 1f else 0f)
        .build(),
    )
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Audio Read playback",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Keeps Audio Read active while reading documents"
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun notification(): Notification {
    val openIntent = Intent(this, MainActivity::class.java)
    val contentIntent = PendingIntent.getActivity(
      this,
      0,
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val playPause = if (playing) {
      action(android.R.drawable.ic_media_pause, "Pause", PLAYBACK_COMMAND_PAUSE, 2)
    } else {
      action(android.R.drawable.ic_media_play, "Play", PLAYBACK_COMMAND_PAUSE, 2)
    }

    val mediaStyle = Notification.MediaStyle()
      // Show prev / play-pause / next inline on the collapsed card, like a music player.
      .setShowActionsInCompactView(0, 1, 2)
    mediaSession?.let { mediaStyle.setMediaSession(it.sessionToken) }

    return Notification.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(subtitle)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentIntent(contentIntent)
      .setDeleteIntent(
        PendingIntent.getService(
          this,
          9,
          stopIntent(this),
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
      .addAction(action(android.R.drawable.ic_media_previous, "Previous", PLAYBACK_COMMAND_PREVIOUS, 1))
      .addAction(playPause)
      .addAction(action(android.R.drawable.ic_media_next, "Next", PLAYBACK_COMMAND_NEXT, 3))
      .setStyle(mediaStyle)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOngoing(playing)
      .setOnlyAlertOnce(true)
      .build()
  }

  private fun action(icon: Int, label: String, command: String, requestCode: Int): Notification.Action =
    Notification.Action.Builder(icon, label, commandPendingIntent(command, requestCode)).build()

  private fun commandPendingIntent(command: String, requestCode: Int): PendingIntent {
    val intent = Intent(PLAYBACK_COMMAND_ACTION)
      .setPackage(packageName)
      .putExtra(PLAYBACK_COMMAND_EXTRA, command)
    return PendingIntent.getBroadcast(
      this,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  @Suppress("DEPRECATION")
  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      stopForeground(true)
    }
  }

  companion object {
    fun startIntent(context: Context): Intent =
      Intent(context, AudioReadPlaybackService::class.java).setAction(ACTION_START)

    fun stopIntent(context: Context): Intent =
      Intent(context, AudioReadPlaybackService::class.java).setAction(ACTION_STOP)

    fun updateIntent(
      context: Context,
      title: String,
      subtitle: String,
      playing: Boolean,
      elapsedMs: Long,
      durationMs: Long,
    ): Intent =
      Intent(context, AudioReadPlaybackService::class.java)
        .setAction(ACTION_UPDATE)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_SUBTITLE, subtitle)
        .putExtra(EXTRA_PLAYING, playing)
        .putExtra(EXTRA_ELAPSED_MS, elapsedMs)
        .putExtra(EXTRA_DURATION_MS, durationMs)
  }
}
