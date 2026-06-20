package com.audioreadnative.tts

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import com.audioreadnative.LogStore
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.ByteArrayOutputStream
import java.io.StringReader
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory

private const val DOCUMENT_PICK_REQUEST = 4207
private const val DOCUMENT_TAG = "AudioReadDocument"

class DocumentModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  private var pendingPick: Promise? = null

  private val activityListener: ActivityEventListener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      if (requestCode != DOCUMENT_PICK_REQUEST) return
      val promise = pendingPick ?: return
      pendingPick = null
      if (resultCode != Activity.RESULT_OK || data?.data == null) {
        LogStore.write(DOCUMENT_TAG, "pick cancelled")
        promise.reject("DOCUMENT_PICK_CANCELLED", "No document selected")
        return
      }
      val uri = data.data!!
      reactContext.contentResolver.takePersistableUriPermissionSafe(uri, data.flags)
      Thread {
        try {
          val result = extract(uri)
          promise.resolve(result)
        } catch (e: Throwable) {
          LogStore.write(DOCUMENT_TAG, "extract failed: ${e.stackTraceToString()}")
          promise.reject("DOCUMENT_EXTRACT_FAILED", e.message, e)
        }
      }.start()
    }
  }

  init {
    reactContext.addActivityEventListener(activityListener)
    PDFBoxResourceLoader.init(reactContext)
  }

  override fun getName() = "DocumentReader"

  @ReactMethod
  fun pickDocument(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "No active Android activity")
      return
    }
    if (pendingPick != null) {
      promise.reject("PICK_IN_PROGRESS", "A document picker is already open")
      return
    }
    pendingPick = promise
    LogStore.write(DOCUMENT_TAG, "pick requested")
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(
        Intent.EXTRA_MIME_TYPES,
        arrayOf(
          "application/pdf",
          "application/epub+zip",
          "application/octet-stream",
          "text/plain",
        ),
      )
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    }
    activity.startActivityForResult(intent, DOCUMENT_PICK_REQUEST)
  }

  private fun extract(uri: Uri) = when (val name = displayName(uri)) {
    null -> extractByMime(uri, "Document")
    else -> extractByMime(uri, name)
  }

  private fun extractByMime(uri: Uri, title: String): com.facebook.react.bridge.WritableMap {
    val lower = title.lowercase(Locale.US)
    val mime = reactContext.contentResolver.getType(uri).orEmpty().lowercase(Locale.US)
    LogStore.write(DOCUMENT_TAG, "extract title=$title mime=$mime")
    val text = when {
      lower.endsWith(".pdf") || mime == "application/pdf" -> extractPdf(uri)
      lower.endsWith(".epub") || mime == "application/epub+zip" -> extractEpub(uri)
      lower.endsWith(".txt") || mime.startsWith("text/") -> readText(uri)
      else -> throw IllegalArgumentException("Unsupported document type. Choose a PDF, EPUB, or TXT file.")
    }.normalizeDocumentText()

    if (text.length < 40) throw IllegalArgumentException("No readable text found in this document.")
    LogStore.write(DOCUMENT_TAG, "extract resolved chars=${text.length}")
    return Arguments.createMap().apply {
      putString("title", title)
      putString("text", text)
      putString("uri", uri.toString())
      putString("kind", when {
        lower.endsWith(".epub") || mime == "application/epub+zip" -> "epub"
        lower.endsWith(".pdf") || mime == "application/pdf" -> "pdf"
        else -> "text"
      })
    }
  }

  private fun extractPdf(uri: Uri): String {
    reactContext.contentResolver.openInputStream(uri).use { input ->
      if (input == null) throw IllegalArgumentException("Could not open PDF")
      PDDocument.load(input).use { doc ->
        return PDFTextStripper().getText(doc)
      }
    }
  }

  private fun extractEpub(uri: Uri): String {
    val entries = readEpubEntries(uri)
    val orderedHtmlPaths = epubReadingOrder(entries)
    val htmlPaths = orderedHtmlPaths.ifEmpty {
      entries.keys
        .filter { it.isHtmlPath() }
        .sorted()
        .also { LogStore.write(DOCUMENT_TAG, "epub spine unavailable; using sorted html fallback count=${it.size}") }
    }
    val out = StringBuilder()
    htmlPaths.forEach { path ->
      val bytes = entries[path] ?: return@forEach
      out.append('\n')
      out.append(bytes.toString(Charsets.UTF_8).htmlToText())
      out.append('\n')
    }
    LogStore.write(DOCUMENT_TAG, "epub extracted htmlFiles=${htmlPaths.size}")
    return out.toString()
  }

  private fun readEpubEntries(uri: Uri): Map<String, ByteArray> {
    val entries = linkedMapOf<String, ByteArray>()
    reactContext.contentResolver.openInputStream(uri).use { input ->
      if (input == null) throw IllegalArgumentException("Could not open EPUB")
      ZipInputStream(input).use { zip ->
        var entry = zip.nextEntry
        while (entry != null) {
          if (!entry.isDirectory && entry.isUsefulEpubEntry()) {
            ByteArrayOutputStream().use { bytes ->
              zip.copyTo(bytes)
              entries[entry.name] = bytes.toByteArray()
            }
          }
          zip.closeEntry()
          entry = zip.nextEntry
        }
      }
    }
    return entries
  }

  private fun epubReadingOrder(entries: Map<String, ByteArray>): List<String> {
    return try {
      val container = entries["META-INF/container.xml"]?.toString(Charsets.UTF_8)
        ?: entries.entries.firstOrNull { it.key.equals("META-INF/container.xml", ignoreCase = true) }
          ?.value
          ?.toString(Charsets.UTF_8)
        ?: return emptyList()
      val opfPath = parseContainerOpfPath(container) ?: return emptyList()
      val opf = entries[opfPath]?.toString(Charsets.UTF_8) ?: return emptyList()
      val parsed = parseOpf(opf)
      val basePath = opfPath.substringBeforeLast('/', "")
      parsed.spine
        .mapNotNull { idRef -> parsed.manifest[idRef] }
        .map { href -> joinEpubPath(basePath, href) }
        .filter { path -> entries[path] != null && path.isHtmlPath() }
        .also { LogStore.write(DOCUMENT_TAG, "epub spine resolved count=${it.size}") }
    } catch (e: Throwable) {
      LogStore.write(DOCUMENT_TAG, "epub spine parse failed: ${e.message}")
      emptyList()
    }
  }

  private fun parseContainerOpfPath(xml: String): String? {
    val parser = newXmlParser(xml)
    while (parser.eventType != XmlPullParser.END_DOCUMENT) {
      if (parser.eventType == XmlPullParser.START_TAG && parser.name == "rootfile") {
        return parser.getAttributeValue(null, "full-path")
      }
      parser.next()
    }
    return null
  }

  private fun parseOpf(xml: String): EpubOpf {
    val manifest = linkedMapOf<String, String>()
    val spine = mutableListOf<String>()
    val parser = newXmlParser(xml)
    while (parser.eventType != XmlPullParser.END_DOCUMENT) {
      if (parser.eventType == XmlPullParser.START_TAG) {
        when (parser.name) {
          "item" -> {
            val id = parser.getAttributeValue(null, "id")
            val href = parser.getAttributeValue(null, "href")
            if (!id.isNullOrBlank() && !href.isNullOrBlank()) manifest[id] = href
          }
          "itemref" -> {
            val idRef = parser.getAttributeValue(null, "idref")
            if (!idRef.isNullOrBlank()) spine.add(idRef)
          }
        }
      }
      parser.next()
    }
    return EpubOpf(manifest, spine)
  }

  private fun newXmlParser(xml: String): XmlPullParser =
    XmlPullParserFactory.newInstance().newPullParser().apply {
      setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
      setInput(StringReader(xml))
      nextTag()
    }

  private fun readText(uri: Uri): String {
    reactContext.contentResolver.openInputStream(uri).use { input ->
      if (input == null) throw IllegalArgumentException("Could not open text file")
      return input.bufferedReader().readText()
    }
  }

  private fun displayName(uri: Uri): String? {
    reactContext.contentResolver.query(uri, null, null, null, null).use { cursor ->
      if (cursor != null && cursor.moveToFirst()) {
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index >= 0) return cursor.getString(index)
      }
    }
    return uri.lastPathSegment
  }
}

private data class EpubOpf(
  val manifest: Map<String, String>,
  val spine: List<String>,
)

private fun android.content.ContentResolver.takePersistableUriPermissionSafe(uri: Uri, flags: Int) {
  try {
    takePersistableUriPermission(uri, flags and Intent.FLAG_GRANT_READ_URI_PERMISSION)
  } catch (_: Throwable) {
  }
}

private fun String.htmlToText(): String = this
  .replace(Regex("(?is)<(script|style).*?</\\1>"), " ")
  .replace(Regex("(?is)<br\\s*/?>"), "\n")
  .replace(Regex("(?is)</p\\s*>"), "\n")
  .replace(Regex("(?is)<[^>]+>"), " ")
  .replace("&nbsp;", " ")
  .replace("&amp;", "&")
  .replace("&quot;", "\"")
  .replace("&#39;", "'")
  .replace("&lt;", "<")
  .replace("&gt;", ">")

private fun String.normalizeDocumentText(): String = this
  .replace(Regex("[\\t\\x0B\\f\\r]+"), " ")
  .replace(Regex(" *\\n *"), "\n")
  .replace(Regex("\\n{3,}"), "\n\n")
  .replace(Regex(" {2,}"), " ")
  .trim()

private fun ZipEntry.isUsefulEpubEntry(): Boolean {
  val lower = name.lowercase(Locale.US)
  return lower == "meta-inf/container.xml" ||
    lower.endsWith(".opf") ||
    lower.endsWith(".xhtml") ||
    lower.endsWith(".html") ||
    lower.endsWith(".htm")
}

private fun String.isHtmlPath(): Boolean {
  val lower = lowercase(Locale.US)
  return lower.endsWith(".xhtml") || lower.endsWith(".html") || lower.endsWith(".htm")
}

private fun joinEpubPath(basePath: String, href: String): String {
  val hrefWithoutFragment = href.substringBefore('#')
  val raw = if (basePath.isBlank()) hrefWithoutFragment else "$basePath/$hrefWithoutFragment"
  val parts = mutableListOf<String>()
  raw.split('/').forEach { part ->
    when (part) {
      "", "." -> Unit
      ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.lastIndex)
      else -> parts.add(part)
    }
  }
  return parts.joinToString("/")
}
