package com.audioreadnative.tts

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import com.audioreadnative.LogStore
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.File
import java.io.ByteArrayOutputStream
import java.io.FileOutputStream
import java.io.StringReader
import java.util.UUID
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import kotlin.math.max
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory

private const val DOCUMENT_PICK_REQUEST = 4207
private const val DOCUMENT_TAG = "AudioReadDocument"
private const val LIBRARY_DIR = "library"
private const val LIBRARY_INDEX = "index.json"

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

  @ReactMethod
  fun listLibrary(promise: Promise) {
    Thread {
      try {
        val array = Arguments.createArray()
        readLibraryIndex()
          .sortedByDescending { it.optLong("updatedAt", it.optLong("createdAt", 0L)) }
          .forEach { item -> array.pushMap(item.toWritableMap()) }
        promise.resolve(array)
      } catch (e: Throwable) {
        LogStore.write(DOCUMENT_TAG, "listLibrary failed: ${e.stackTraceToString()}")
        promise.reject("LIBRARY_LIST_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun saveLibraryDocument(
    title: String,
    kind: String,
    uri: String,
    text: String,
    sentenceCount: Int,
    promise: Promise,
  ) {
    Thread {
      try {
        val id = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        libraryRoot().mkdirs()
        File(libraryRoot(), "$id.txt").writeText(text)
        val item = JSONObject().apply {
          put("id", id)
          put("title", title)
          put("kind", kind)
          put("uri", uri)
          put("sentenceCount", sentenceCount)
          put("charCount", text.length)
          put("createdAt", now)
          put("updatedAt", now)
          put("lastPosition", 0)
        }
        // Persist the original document so we can render it later without relying on the
        // (potentially revoked) content URI.
        try {
          prepareRenderAssets(id, kind, Uri.parse(uri), item)
        } catch (e: Throwable) {
          LogStore.write(DOCUMENT_TAG, "prepareRenderAssets failed id=$id: ${e.stackTraceToString()}")
        }
        val items = readLibraryIndex().filter { it.optString("uri") != uri }.toMutableList()
        items.add(item)
        writeLibraryIndex(items)
        LogStore.write(DOCUMENT_TAG, "library saved id=$id title=$title sentences=$sentenceCount kind=$kind")
        promise.resolve(item.toWritableMap())
      } catch (e: Throwable) {
        LogStore.write(DOCUMENT_TAG, "saveLibraryDocument failed: ${e.stackTraceToString()}")
        promise.reject("LIBRARY_SAVE_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun loadLibraryDocument(id: String, promise: Promise) {
    Thread {
      try {
        val item = readLibraryIndex().firstOrNull { it.optString("id") == id }
          ?: throw IllegalArgumentException("Book not found in library")
        val textFile = File(libraryRoot(), "$id.txt")
        if (!textFile.exists()) throw IllegalArgumentException("Book text is missing from storage")
        val result = item.toWritableMap()
        result.putString("text", textFile.readText())
        promise.resolve(result)
      } catch (e: Throwable) {
        LogStore.write(DOCUMENT_TAG, "loadLibraryDocument failed id=$id: ${e.stackTraceToString()}")
        promise.reject("LIBRARY_LOAD_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun updateLibraryDocument(id: String, patch: ReadableMap, promise: Promise) {
    Thread {
      try {
        val items = readLibraryIndex().toMutableList()
        val index = items.indexOfFirst { it.optString("id") == id }
        if (index < 0) throw IllegalArgumentException("Book not found in library")
        val item = items[index]
        patch.toHashMap().forEach { (key, value) ->
          when (value) {
            null -> item.put(key, JSONObject.NULL)
            is Number -> item.put(key, value)
            is Boolean -> item.put(key, value)
            else -> item.put(key, value.toString())
          }
        }
        item.put("updatedAt", System.currentTimeMillis())
        items[index] = item
        writeLibraryIndex(items)
        promise.resolve(item.toWritableMap())
      } catch (e: Throwable) {
        LogStore.write(DOCUMENT_TAG, "updateLibraryDocument failed id=$id: ${e.stackTraceToString()}")
        promise.reject("LIBRARY_UPDATE_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun deleteLibraryDocument(id: String, promise: Promise) {
    Thread {
      try {
        val items = readLibraryIndex().filterNot { it.optString("id") == id }
        writeLibraryIndex(items)
        File(libraryRoot(), "$id.txt").delete()
        sourceFile(id).delete()
        epubDir(id).deleteRecursively()
        clearRenderedPages(id)
        LogStore.write(DOCUMENT_TAG, "library deleted id=$id")
        promise.resolve(null)
      } catch (e: Throwable) {
        LogStore.write(DOCUMENT_TAG, "deleteLibraryDocument failed id=$id: ${e.stackTraceToString()}")
        promise.reject("LIBRARY_DELETE_FAILED", e.message, e)
      }
    }.start()
  }

  /**
   * Returns rendering metadata for a saved book so the JS layer can show the original
   * document. For EPUB: an ordered list of file:// spine chapter URIs + base dir. For
   * PDF: the page count and source file path.
   */
  @ReactMethod
  fun getBookManifest(id: String, promise: Promise) {
    Thread {
      try {
        val item = readLibraryIndex().firstOrNull { it.optString("id") == id }
          ?: throw IllegalArgumentException("Book not found in library")
        val kind = item.optString("kind")
        val map = Arguments.createMap()
        map.putString("id", id)
        map.putString("kind", kind)
        when (kind) {
          "epub" -> {
            val dir = epubDir(id)
            val spine = item.optJSONArray("spine")
            if (!dir.exists() || spine == null || spine.length() == 0) {
              throw IllegalStateException("EPUB render assets unavailable")
            }
            val chapters = Arguments.createArray()
            for (i in 0 until spine.length()) {
              val rel = spine.getString(i)
              val file = File(dir, rel)
              if (file.exists()) {
                chapters.pushMap(Arguments.createMap().apply {
                  putString("uri", Uri.fromFile(file).toString())
                  putString("path", rel)
                })
              }
            }
            map.putArray("chapters", chapters)
            map.putString("baseDir", Uri.fromFile(dir).toString())
          }
          "pdf" -> {
            val src = sourceFile(id)
            if (!src.exists()) throw IllegalStateException("PDF source unavailable")
            map.putInt("pageCount", item.optInt("pageCount", pdfPageCount(src)))
            map.putString("sourcePath", src.absolutePath)
          }
          else -> Unit
        }
        promise.resolve(map)
      } catch (e: Throwable) {
        LogStore.write(DOCUMENT_TAG, "getBookManifest failed id=$id: ${e.stackTraceToString()}")
        promise.reject("BOOK_MANIFEST_FAILED", e.message, e)
      }
    }.start()
  }

  /** Renders a single PDF page to a cached PNG and returns its path + pixel size. */
  @ReactMethod
  fun renderPdfPage(id: String, pageIndex: Int, targetWidth: Int, promise: Promise) {
    Thread {
      try {
        val src = sourceFile(id)
        if (!src.exists()) throw IllegalStateException("PDF source unavailable")
        val outFile = File(renderedPagesDir(id), "p${pageIndex}_w${targetWidth}.png")
        if (!outFile.exists()) {
          renderedPagesDir(id).mkdirs()
          ParcelFileDescriptor.open(src, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
            PdfRenderer(pfd).use { renderer ->
              if (pageIndex < 0 || pageIndex >= renderer.pageCount) {
                throw IllegalArgumentException("Page out of range")
              }
              renderer.openPage(pageIndex).use { page ->
                val width = if (targetWidth > 0) targetWidth else page.width
                val scale = width.toFloat() / page.width.toFloat()
                val height = max(1, (page.height * scale).toInt())
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(Color.WHITE)
                Canvas(bitmap).drawColor(Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                FileOutputStream(outFile).use { out ->
                  bitmap.compress(Bitmap.CompressFormat.PNG, 90, out)
                }
                bitmap.recycle()
              }
            }
          }
        }
        val (w, h) = pngDimensions(outFile)
        promise.resolve(Arguments.createMap().apply {
          putString("uri", Uri.fromFile(outFile).toString())
          putInt("page", pageIndex)
          putInt("width", w)
          putInt("height", h)
        })
      } catch (e: Throwable) {
        LogStore.write(DOCUMENT_TAG, "renderPdfPage failed id=$id page=$pageIndex: ${e.stackTraceToString()}")
        promise.reject("PDF_RENDER_FAILED", e.message, e)
      }
    }.start()
  }

  private fun prepareRenderAssets(id: String, kind: String, uri: Uri, item: JSONObject) {
    when (kind) {
      "pdf" -> {
        val src = sourceFile(id)
        copyUriToFile(uri, src)
        item.put("pageCount", pdfPageCount(src))
        LogStore.write(DOCUMENT_TAG, "pdf source cached id=$id pages=${item.optInt("pageCount")}")
      }
      "epub" -> {
        val src = sourceFile(id)
        copyUriToFile(uri, src)
        val spine = unzipEpubToDir(src, epubDir(id))
        val array = JSONArray()
        spine.forEach { array.put(it) }
        item.put("spine", array)
        LogStore.write(DOCUMENT_TAG, "epub assets extracted id=$id chapters=${spine.size}")
      }
      else -> Unit
    }
  }

  private fun copyUriToFile(uri: Uri, dest: File) {
    dest.parentFile?.mkdirs()
    reactContext.contentResolver.openInputStream(uri).use { input ->
      if (input == null) throw IllegalArgumentException("Could not open source document")
      FileOutputStream(dest).use { output -> input.copyTo(output) }
    }
  }

  private fun pdfPageCount(file: File): Int {
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
      PdfRenderer(pfd).use { return it.pageCount }
    }
  }

  /** Unzips every EPUB entry to [destDir] and returns the spine chapters as relative paths. */
  private fun unzipEpubToDir(epub: File, destDir: File): List<String> {
    destDir.deleteRecursively()
    destDir.mkdirs()
    val canonicalRoot = destDir.canonicalPath
    epub.inputStream().use { fileInput ->
      ZipInputStream(fileInput).use { zip ->
        var entry = zip.nextEntry
        while (entry != null) {
          if (!entry.isDirectory) {
            val outFile = File(destDir, entry.name)
            if (outFile.canonicalPath.startsWith(canonicalRoot)) {
              outFile.parentFile?.mkdirs()
              FileOutputStream(outFile).use { out -> zip.copyTo(out) }
            }
          }
          zip.closeEntry()
          entry = zip.nextEntry
        }
      }
    }
    return computeSpineFromDir(destDir)
  }

  private fun computeSpineFromDir(dir: File): List<String> {
    val container = File(dir, "META-INF/container.xml")
    if (!container.exists()) return fallbackHtmlList(dir)
    val opfPath = parseContainerOpfPath(container.readText()) ?: return fallbackHtmlList(dir)
    val opfFile = File(dir, opfPath)
    if (!opfFile.exists()) return fallbackHtmlList(dir)
    val parsed = parseOpf(opfFile.readText())
    val basePath = opfPath.substringBeforeLast('/', "")
    val spine = parsed.spine
      .mapNotNull { idRef -> parsed.manifest[idRef] }
      .map { item -> joinEpubPath(basePath, item.href) }
      .filter { rel -> File(dir, rel).exists() && rel.isHtmlPath() }
    return spine.ifEmpty { fallbackHtmlList(dir) }
  }

  private fun fallbackHtmlList(dir: File): List<String> =
    dir.walkTopDown()
      .filter { it.isFile && it.path.isHtmlPath() }
      .map { it.relativeTo(dir).path }
      .sorted()
      .toList()

  private fun sourceFile(id: String): File = File(libraryRoot(), "$id.src")

  private fun epubDir(id: String): File = File(libraryRoot(), "${id}_book")

  private fun renderedPagesDir(id: String): File = File(reactContext.cacheDir, "pdf_pages/$id")

  private fun clearRenderedPages(id: String) {
    renderedPagesDir(id).deleteRecursively()
  }

  private fun pngDimensions(file: File): Pair<Int, Int> {
    val options = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    android.graphics.BitmapFactory.decodeFile(file.absolutePath, options)
    return options.outWidth to options.outHeight
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
        return PDFTextStripper().apply {
          sortByPosition = true
          addMoreFormatting = true
        }.getText(doc)
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
      val text = bytes.toString(Charsets.UTF_8).htmlToText()
      out.append('\n')
      out.append(text)
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
        .map { item -> joinEpubPath(basePath, item.href) }
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
    val manifest = linkedMapOf<String, EpubManifestItem>()
    val spine = mutableListOf<String>()
    val parser = newXmlParser(xml)
    while (parser.eventType != XmlPullParser.END_DOCUMENT) {
      if (parser.eventType == XmlPullParser.START_TAG) {
        when (parser.name) {
          "item" -> {
            val id = parser.getAttributeValue(null, "id")
            val href = parser.getAttributeValue(null, "href")
            val properties = parser.getAttributeValue(null, "properties").orEmpty()
            if (!id.isNullOrBlank() && !href.isNullOrBlank()) {
              manifest[id] = EpubManifestItem(id, href, properties)
            }
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

  private fun libraryRoot(): File = File(reactContext.filesDir, LIBRARY_DIR)

  private fun libraryIndexFile(): File = File(libraryRoot(), LIBRARY_INDEX)

  private fun readLibraryIndex(): List<JSONObject> {
    val file = libraryIndexFile()
    if (!file.exists()) return emptyList()
    val array = JSONArray(file.readText())
    return (0 until array.length()).map { array.getJSONObject(it) }
  }

  private fun writeLibraryIndex(items: List<JSONObject>) {
    libraryRoot().mkdirs()
    val array = JSONArray()
    items.forEach { array.put(it) }
    libraryIndexFile().writeText(array.toString())
  }
}

private data class EpubManifestItem(
  val id: String,
  val href: String,
  val properties: String,
)

private data class EpubOpf(
  val manifest: Map<String, EpubManifestItem>,
  val spine: List<String>,
)

private fun JSONObject.toWritableMap() = Arguments.createMap().also { map ->
  keys().forEach { key ->
    when (val value = opt(key)) {
      null, JSONObject.NULL -> map.putNull(key)
      is Int -> map.putInt(key, value)
      is Long -> map.putDouble(key, value.toDouble())
      is Double -> map.putDouble(key, value)
      is Float -> map.putDouble(key, value.toDouble())
      is Boolean -> map.putBoolean(key, value)
      else -> map.putString(key, value.toString())
    }
  }
}

private fun android.content.ContentResolver.takePersistableUriPermissionSafe(uri: Uri, flags: Int) {
  try {
    takePersistableUriPermission(uri, flags and Intent.FLAG_GRANT_READ_URI_PERMISSION)
  } catch (_: Throwable) {
  }
}

private fun String.htmlToText(): String = this
  .replace(Regex("(?is)<(script|style|nav|head|metadata|svg).*?</\\1>"), " ")
  .replace(Regex("(?is)<span\\b[^>]*(?:pagebreak|pagenum|linenum)[^>]*>.*?</span>"), " ")
  .replace(Regex("(?is)<hr\\b[^>]*>"), "\n\n")
  .replace(Regex("(?is)<br\\s*/?>"), "\n")
  .replace(Regex("(?is)</h[1-6]\\s*>"), "\n\n")
  .replace(Regex("(?is)<(h[1-6]|p|div|section|article|li|blockquote|tr)[^>]*>"), "\n")
  .replace(Regex("(?is)</(h[1-6]|p|div|section|article|li|blockquote|tr)\\s*>"), "\n")
  .replace(Regex("(?is)<a\\b[^>]*/>"), " ")
  .replace(Regex("(?is)<[^>]+>"), " ")
  .replace("&nbsp;", " ")
  .replace("&amp;", "&")
  .replace("&quot;", "\"")
  .replace("&#39;", "'")
  .replace("&lt;", "<")
  .replace("&gt;", ">")
  .decodeNumericEntities()

private fun String.normalizeDocumentText(): String = this
  .replace(Regex("[\\t\\x0B\\f\\r]+"), " ")
  .replace(Regex(" *\\n *"), "\n")
  .replace(Regex("(?m)^\\s*(page\\s*)?\\d{1,4}\\s*$", RegexOption.IGNORE_CASE), "")
  .replace(Regex("(?m)^\\s*\\[(?:pg|page)\\s*\\d{1,4}]\\s*$", RegexOption.IGNORE_CASE), "")
  .replace(Regex("\\n{3,}"), "\n\n")
  .replace(Regex(" {2,}"), " ")
  .trim()

private fun String.decodeNumericEntities(): String =
  replace(Regex("&#(x?[0-9A-Fa-f]+);")) { match ->
    val raw = match.groupValues[1]
    val code = if (raw.startsWith("x", ignoreCase = true)) {
      raw.drop(1).toIntOrNull(16)
    } else {
      raw.toIntOrNull()
    }
    code?.takeIf { it > 0 }?.let { String(Character.toChars(it)) } ?: match.value
  }

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
