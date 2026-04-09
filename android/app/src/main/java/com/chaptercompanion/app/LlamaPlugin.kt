package com.chaptercompanion.app

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.*

@CapacitorPlugin(name = "LlamaPlugin")
class LlamaPlugin : Plugin() {
    private lateinit var llamaBridge: LlamaBridge
    private var downloadJob: Job? = null

    override fun load() {
        llamaBridge = LlamaBridge(context)
    }

    // -----------------------------------------------------------------------
    // Model management
    // -----------------------------------------------------------------------

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        val urlStr = call.getString("url") ?: return call.reject("Missing url")
        val fileName = call.getString("fileName") ?: return call.reject("Missing fileName")
        val dest = File(llamaBridge.modelsDir(), fileName)
        val tempDest = File(llamaBridge.modelsDir(), "$fileName.part")

        downloadJob = CoroutineScope(Dispatchers.IO).launch {
            try {
                val url = URL(urlStr)
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 15_000
                conn.readTimeout = 30_000
                conn.connect()

                if (conn.responseCode != 200) {
                    call.reject("Download failed: HTTP ${conn.responseCode}")
                    return@launch
                }

                val totalBytes = conn.contentLengthLong
                var bytesDownloaded = 0L
                val buffer = ByteArray(8192)

                conn.inputStream.use { input ->
                    FileOutputStream(tempDest).use { output ->
                        while (isActive) {
                            val read = input.read(buffer)
                            if (read == -1) break
                            output.write(buffer, 0, read)
                            bytesDownloaded += read

                            // Emit progress every ~100KB
                            if (bytesDownloaded % (100 * 1024) < 8192) {
                                val progress = JSObject()
                                progress.put("bytesDownloaded", bytesDownloaded)
                                progress.put("totalBytes", totalBytes)
                                notifyListeners("downloadProgress", progress)
                            }
                        }
                    }
                }

                if (!isActive) {
                    tempDest.delete()
                    call.reject("Download cancelled")
                    return@launch
                }

                tempDest.renameTo(dest)
                call.resolve()
            } catch (e: Exception) {
                tempDest.delete()
                call.reject("Download failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        downloadJob?.cancel()
        downloadJob = null
        call.resolve()
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) {
        val fileName = call.getString("fileName") ?: return call.reject("Missing fileName")
        val file = File(llamaBridge.modelsDir(), fileName)
        if (file.exists()) file.delete()
        call.resolve()
    }

    @PluginMethod
    fun listModels(call: PluginCall) {
        val dir = llamaBridge.modelsDir()
        val models = JSONArray()
        dir.listFiles()?.filter { it.extension == "gguf" }?.forEach { file ->
            val model = JSObject()
            model.put("fileName", file.name)
            model.put("sizeBytes", file.length())
            models.put(model)
        }
        val result = JSObject()
        result.put("models", models)
        call.resolve(result)
    }

    @PluginMethod
    fun getFreeDiskSpace(call: PluginCall) {
        val result = JSObject()
        result.put("bytes", llamaBridge.modelsDir().usableSpace)
        call.resolve(result)
    }

    // -----------------------------------------------------------------------
    // Inference
    // -----------------------------------------------------------------------

    @PluginMethod
    fun loadModel(call: PluginCall) {
        val fileName = call.getString("fileName") ?: return call.reject("Missing fileName")
        val contextLength = call.getInt("contextLength") ?: 8192
        val path = llamaBridge.modelPath(fileName)

        if (!File(path).exists()) {
            return call.reject("Model file not found: $fileName")
        }

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val ok = llamaBridge.nativeLoadModel(path, contextLength)
                if (ok) call.resolve() else call.reject("Failed to load model — possibly not enough RAM")
            } catch (e: Exception) {
                call.reject("Load failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun unloadModel(call: PluginCall) {
        llamaBridge.nativeUnloadModel()
        call.resolve()
    }

    @PluginMethod
    fun isModelLoaded(call: PluginCall) {
        val loaded = llamaBridge.nativeIsLoaded()
        val loadedPath = llamaBridge.nativeGetLoadedPath()
        val result = JSObject()
        result.put("loaded", loaded)
        // Extract just the filename from the full path
        val fileName = if (loadedPath.isNotEmpty()) File(loadedPath as String).name else null
        result.put("fileName", fileName)
        call.resolve(result)
    }

    @PluginMethod
    fun chatCompletion(call: PluginCall) {
        val messagesArray = call.getArray("messages") ?: return call.reject("Missing messages")

        val roles = mutableListOf<String>()
        val contents = mutableListOf<String>()

        for (i in 0 until messagesArray.length()) {
            val msg = messagesArray.getJSONObject(i)
            roles.add(msg.getString("role"))
            contents.add(msg.getString("content"))
        }

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val result = llamaBridge.nativeChatCompletion(
                    roles.toTypedArray(),
                    contents.toTypedArray()
                )
                val response = JSObject()
                response.put("text", result as String)
                call.resolve(response)
            } catch (e: Exception) {
                call.reject("Inference failed: ${e.message}")
            }
        }
    }
}
