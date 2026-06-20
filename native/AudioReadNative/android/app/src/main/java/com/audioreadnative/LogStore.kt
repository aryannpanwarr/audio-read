package com.audioreadnative

import android.content.Context
import android.os.Build
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object LogStore {
  private val lock = Any()
  private val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)
  private var logDir: File? = null
  private var runFile: File? = null

  fun init(context: Context) {
    synchronized(lock) {
      if (runFile != null) return
      val dir = File(context.filesDir, "run-logs")
      dir.mkdirs()
      logDir = dir
      runFile = File(dir, "run-${System.currentTimeMillis()}.log")
      trimOldLogs(dir)
      writeLocked("app", "run-start")
      writeLocked(
        "device",
        "manufacturer=${Build.MANUFACTURER}; model=${Build.MODEL}; sdk=${Build.VERSION.SDK_INT}; abi=${Build.SUPPORTED_ABIS.joinToString(",")}",
      )
      writeLocked(
        "build",
        "version=${BuildConfig.VERSION_NAME}; code=${BuildConfig.VERSION_CODE}; type=${BuildConfig.BUILD_TYPE}",
      )
    }
  }

  fun installCrashHandler() {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      write("fatal", "uncaught on ${thread.name}: ${throwable.stackTraceToString()}")
      previous?.uncaughtException(thread, throwable)
    }
  }

  fun write(tag: String, message: String) {
    synchronized(lock) {
      writeLocked(tag, message)
    }
  }

  fun exportFile(context: Context): File {
    synchronized(lock) {
      val out = File(context.cacheDir, "audio-read-native-logs.txt")
      val dir = logDir ?: File(context.filesDir, "run-logs")
      val files = dir.listFiles { file -> file.isFile && file.name.endsWith(".log") }
        ?.sortedBy { it.name }
        ?: emptyList()
      out.bufferedWriter().use { writer ->
        writer.appendLine("Audio Read Native logs")
        writer.appendLine("Exported: ${stamp.format(Date())}")
        writer.appendLine("Files: ${files.size}")
        writer.appendLine()
        for (file in files) {
          writer.appendLine("===== ${file.name} =====")
          writer.append(file.readText())
          writer.appendLine()
        }
      }
      return out
    }
  }

  private fun writeLocked(tag: String, message: String) {
    val file = runFile ?: return
    file.appendText("${stamp.format(Date())} [$tag] $message\n")
  }

  private fun trimOldLogs(dir: File) {
    val files = dir.listFiles { file -> file.isFile && file.name.endsWith(".log") }
      ?.sortedByDescending { it.lastModified() }
      ?: return
    files.drop(10).forEach { it.delete() }
  }
}
