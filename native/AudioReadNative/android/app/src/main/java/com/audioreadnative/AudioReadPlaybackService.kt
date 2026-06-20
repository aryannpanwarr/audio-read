package com.audioreadnative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

private const val CHANNEL_ID = "audio_read_playback"
private const val NOTIFICATION_ID = 1207
private const val ACTION_START = "com.audioreadnative.playback.START"
private const val ACTION_STOP = "com.audioreadnative.playback.STOP"

class AudioReadPlaybackService : Service() {
  override fun onCreate() {
    super.onCreate()
    createChannel()
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
        LogStore.write("playback-service", "start requested")
        startForeground(NOTIFICATION_ID, notification())
        START_STICKY
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    LogStore.write("playback-service", "destroyed")
    super.onDestroy()
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
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Audio Read")
      .setContentText("Reading with Kokoro")
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()
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
    fun startIntent(context: android.content.Context): Intent =
      Intent(context, AudioReadPlaybackService::class.java).setAction(ACTION_START)

    fun stopIntent(context: android.content.Context): Intent =
      Intent(context, AudioReadPlaybackService::class.java).setAction(ACTION_STOP)
  }
}
