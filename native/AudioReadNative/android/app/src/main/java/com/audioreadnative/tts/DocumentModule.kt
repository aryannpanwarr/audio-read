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
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.text.PDFTextStripper
import com.tom_roush.pdfbox.text.TextPosition
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

  /**
   * Builds a single HTML document for the whole EPUB (all spine chapters concatenated)
   * with every relative CSS/image URL rewritten to an absolute file:// path, so it can
   * be shown as one continuous scroll in a WebView.
   */
  @ReactMethod
  fun getEpubCombinedHtml(id: String, promise: Promise) {
    Thread {
      try {
        val item = readLibraryIndex().firstOrNull { it.optString("id") == id }
          ?: throw IllegalArgumentException("Book not found in library")
        if (item.optString("kind") != "epub") throw IllegalStateException("Not an EPUB")
        val dir = epubDir(id)
        val spine = item.optJSONArray("spine")
        if (!dir.exists() || spine == null || spine.length() == 0) {
          throw IllegalStateException("EPUB render assets unavailable")
        }
        val body = StringBuilder()
        for (i in 0 until spine.length()) {
          val rel = spine.getString(i)
          val file = File(dir, rel)
          if (!file.exists()) continue
          val chapterDir = rel.substringBeforeLast('/', "")
          val raw = file.readText()
          // Deliberately drop the EPUB's own CSS/scripts: combining many chapters'
          // stylesheets jumbles the layout. We keep the original markup + images and
          // apply clean reader typography in the WebView instead.
          val bodyInner = (Regex("(?is)<body\\b[^>]*>(.*?)</body>").find(raw)?.groupValues?.get(1) ?: raw)
            .replace(Regex("(?is)<style\\b[^>]*>.*?</style>"), " ")
            .replace(Regex("(?is)<script\\b[^>]*>.*?</script>"), " ")
            .replace(Regex("(?is)<link\\b[^>]*>"), " ")
          body.append("<section class=\"ar-chapter\" id=\"ar-ch-").append(i).append("\">")
          body.append(rewriteHtmlUrls(dir, chapterDir, bodyInner))
          body.append("</section>\n")
        }
        val head = "<meta charset=\"utf-8\">" +
          "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=4\">"
        val html = "<!DOCTYPE html><html><head>$head</head><body>$body</body></html>"
        LogStore.write(DOCUMENT_TAG, "epub combined html id=$id chapters=${spine.length()} bytes=${html.length}")
        promise.resolve(Arguments.createMap().apply {
          putString("html", html)
          putString("baseUrl", Uri.fromFile(dir).toString() + "/")
        })
      } catch (e: Throwable) {
        LogStore.write(DOCUMENT_TAG, "getEpubCombinedHtml failed id=$id: ${e.stackTraceToString()}")
        promise.reject("EPUB_HTML_FAILED", e.message, e)
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

  /**
   * Extracts every PDF sentence together with the page + normalized bounding box of its
   * glyphs, so the JS layer can paint a highlight rectangle over the active sentence on
   * the rendered page (ReadEra / Speechify style) instead of marking the whole page.
   * The sentence list is index-aligned with what TTS reads, so sentence i ↔ box i.
   */
  @ReactMethod
  fun getPdfSentenceBoxes(id: String, promise: Promise) {
    Thread {
      try {
        val src = sourceFile(id)
        if (!src.exists()) throw IllegalStateException("PDF source unavailable")
        val stripper = GlyphStripper().apply { sortByPosition = true }
        src.inputStream().use { input ->
          PDDocument.load(input).use { doc -> stripper.getText(doc) }
        }
        val sentences = buildPdfSentences(stripper.glyphs)
        val array = Arguments.createArray()
        sentences.forEach { s ->
          array.pushMap(Arguments.createMap().apply {
            putString("text", s.text)
            putInt("page", s.page)
            val rects = Arguments.createArray()
            s.rects.forEach { r ->
              rects.pushMap(Arguments.createMap().apply {
                putDouble("x", r.x.toDouble())
                putDouble("y", r.y.toDouble())
                putDouble("w", r.w.toDouble())
                putDouble("h", r.h.toDouble())
              })
            }
            putArray("rects", rects)
          })
        }
        LogStore.write(DOCUMENT_TAG, "pdf sentence boxes id=$id count=${sentences.size}")
        promise.resolve(array)
      } catch (e: Throwable) {
        LogStore.write(DOCUMENT_TAG, "getPdfSentenceBoxes failed id=$id: ${e.stackTraceToString()}")
        promise.reject("PDF_BOXES_FAILED", e.message, e)
      }
    }.start()
  }

  /**
   * Walks the captured glyph stream, rebuilds sentences (terminator split, short
   * fragments merged to >= 45 chars to mirror the JS splitter), and emits ONE tight
   * rectangle per visual line of the sentence on its starting page. Per-line rects
   * (rather than one union box) keep wrapped/multi-line sentences hugging the text
   * instead of covering whole blocks of empty space.
   */
  private fun buildPdfSentences(glyphs: List<GlyphStripper.Glyph>): List<PdfSentence> {
    val out = ArrayList<PdfSentence>()
    val sb = StringBuilder()
    var page = -1
    val pending = ArrayList<GlyphStripper.Glyph>()
    var lastSpace = true
    var lineY = 0f
    var lineH = 0f
    var hasLine = false

    fun flush() {
      val t = sb.toString().trim()
      if (t.length >= 2 && t.any { it.isLetterOrDigit() } && !isPageNumber(t)) {
        val rects = groupLines(pending)
        if (rects.isNotEmpty()) {
          out.add(PdfSentence(t, if (page < 0) 0 else page, rects))
        }
      }
      sb.setLength(0); page = -1; pending.clear(); lastSpace = true; hasLine = false
    }

    for (g in glyphs) {
      if (g.sep) {
        if (!lastSpace) { sb.append(' '); lastSpace = true }
        continue
      }
      // A sentence ends at a layout break, not just a '.': a vertical gap larger than a
      // normal line (paragraph spacing / heading), a jump upward or a page change (a new
      // column / region). Without this, multi-column mastheads + titles + the first body
      // line glue into one giant "sentence" because there is no terminator between them.
      if (hasLine && page >= 0) {
        val h = maxOf(if (g.h > 0f) g.h else lineH, if (lineH > 0f) lineH else g.h)
        val tol = if (h > 0f) h else 0.012f
        val advance = g.y - lineY
        val blockBreak = g.page != page || advance > 1.5f * tol || advance < -0.5f * tol
        if (blockBreak && sb.toString().any { it.isLetterOrDigit() }) {
          flush()
        }
      }
      if (page < 0) page = g.page
      if (!hasLine) {
        lineY = g.y; lineH = if (g.h > 0f) g.h else lineH; hasLine = true
      } else if (g.page == page && kotlin.math.abs(g.y - lineY) > (if (g.h > 0f) g.h else 0.012f) * 0.5f) {
        lineY = g.y; lineH = if (g.h > 0f) g.h else lineH
      }
      sb.append(g.c); lastSpace = false
      // Only the glyphs on the sentence's starting page contribute to its boxes.
      if (g.page == page) pending.add(g)
      if (g.c == '.' || g.c == '!' || g.c == '?') {
        if (sb.toString().trim().length >= 45) flush()
      }
    }
    flush()
    return if (out.size > 8000) out.subList(0, 8000) else out
  }

  /** Groups a sentence's glyphs into per-line tight bounding boxes (normalized 0..1). */
  private fun groupLines(glyphs: List<GlyphStripper.Glyph>): List<LineRect> {
    if (glyphs.isEmpty()) return emptyList()
    val rects = ArrayList<LineRect>()
    var minX = Float.MAX_VALUE
    var minY = Float.MAX_VALUE
    var maxX = -Float.MAX_VALUE
    var maxY = -Float.MAX_VALUE
    var lineY = 0f
    var started = false

    fun push() {
      if (started && maxX > minX && maxY > minY) {
        rects.add(
          LineRect(
            minX.coerceIn(0f, 1f),
            minY.coerceIn(0f, 1f),
            (maxX - minX).coerceIn(0f, 1f),
            (maxY - minY).coerceIn(0f, 1f),
          ),
        )
      }
      minX = Float.MAX_VALUE; minY = Float.MAX_VALUE
      maxX = -Float.MAX_VALUE; maxY = -Float.MAX_VALUE
      started = false
    }

    for (g in glyphs) {
      val tol = (if (g.h > 0f) g.h else 0.012f) * 0.6f
      if (!started) {
        started = true; lineY = g.y
      } else if (kotlin.math.abs(g.y - lineY) > tol) {
        // A vertical jump beyond ~half a line height means a new visual line.
        push()
        started = true; lineY = g.y
      }
      if (g.x < minX) minX = g.x
      if (g.y < minY) minY = g.y
      if (g.x + g.w > maxX) maxX = g.x + g.w
      if (g.y + g.h > maxY) maxY = g.y + g.h
    }
    push()
    return rects
  }

  private fun isPageNumber(t: String): Boolean =
    Regex("^(?:page\\s*)?\\d{1,4}$", RegexOption.IGNORE_CASE).matches(t) ||
      Regex("^\\[?(?:pg|page)\\s*\\d{1,4}]?$", RegexOption.IGNORE_CASE).matches(t)

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

private data class LineRect(
  val x: Float,
  val y: Float,
  val w: Float,
  val h: Float,
)

private data class PdfSentence(
  val text: String,
  val page: Int,
  val rects: List<LineRect>,
)

/**
 * PDFTextStripper that records every glyph's page + normalized position (origin
 * top-left, 0..1 of the crop box) alongside the text, plus word/line separators, so
 * sentences can be re-segmented and given bounding boxes downstream.
 */
private class GlyphStripper : PDFTextStripper() {
  data class Glyph(
    val c: Char,
    val page: Int,
    val x: Float,
    val y: Float,
    val w: Float,
    val h: Float,
    val sep: Boolean,
  )

  val glyphs = ArrayList<Glyph>()
  private var pageW = 1f
  private var pageH = 1f
  private var pageIdx = 0

  override fun startPage(page: PDPage) {
    val box = page.cropBox
    pageW = if (box.width > 0f) box.width else 1f
    pageH = if (box.height > 0f) box.height else 1f
    pageIdx = currentPageNo - 1
    super.startPage(page)
  }

  override fun writeString(text: String, textPositions: List<TextPosition>) {
    for (tp in textPositions) {
      val uni = tp.unicode ?: continue
      val nx = tp.xDirAdj / pageW
      val ny = tp.yDirAdj / pageH
      val nw = tp.widthDirAdj / pageW
      val nh = tp.heightDir / pageH
      for (ch in uni) {
        glyphs.add(Glyph(ch, pageIdx, nx, ny, nw, nh, false))
      }
    }
  }

  override fun writeLineSeparator() {
    glyphs.add(Glyph('\n', pageIdx, 0f, 0f, 0f, 0f, true))
  }

  override fun writeWordSeparator() {
    glyphs.add(Glyph(' ', pageIdx, 0f, 0f, 0f, 0f, true))
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

/** Resolves a chapter-relative resource to an absolute file:// URL, or null to leave it. */
private fun resolveEpubResource(baseDir: File, chapterDir: String, rawValue: String): String? {
  val value = rawValue.trim()
  if (value.isEmpty()) return null
  val lower = value.lowercase(Locale.US)
  if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("data:") ||
    lower.startsWith("file:") || lower.startsWith("mailto:") || lower.startsWith("tel:") ||
    lower.startsWith("//") || value.startsWith("#")
  ) {
    return null
  }
  val joined = joinEpubPath(chapterDir, value)
  if (joined.isBlank()) return null
  return Uri.fromFile(File(baseDir, joined)).toString()
}

private fun rewriteHtmlUrls(baseDir: File, chapterDir: String, html: String): String {
  val attrRegex = Regex("(?i)(src|href|xlink:href)(\\s*=\\s*)([\"'])(.*?)\\3")
  val withAttrs = attrRegex.replace(html) { m ->
    val resolved = resolveEpubResource(baseDir, chapterDir, m.groupValues[4])
    if (resolved == null) m.value
    else "${m.groupValues[1]}${m.groupValues[2]}${m.groupValues[3]}$resolved${m.groupValues[3]}"
  }
  return rewriteCssUrls(baseDir, chapterDir, withAttrs)
}

private fun rewriteCssUrls(baseDir: File, chapterDir: String, css: String): String {
  val urlRegex = Regex("(?i)url\\(\\s*([\"']?)(.*?)\\1\\s*\\)")
  return urlRegex.replace(css) { m ->
    val resolved = resolveEpubResource(baseDir, chapterDir, m.groupValues[2])
    if (resolved == null) m.value else "url(${m.groupValues[1]}$resolved${m.groupValues[1]})"
  }
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
