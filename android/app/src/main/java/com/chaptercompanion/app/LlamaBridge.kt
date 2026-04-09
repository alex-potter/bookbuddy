package com.chaptercompanion.app

import android.content.Context

class LlamaBridge(private val context: Context) {
    companion object {
        init {
            System.loadLibrary("llama-jni")
        }
    }

    fun modelsDir(): java.io.File {
        val dir = java.io.File(context.filesDir, "llama-models")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    fun modelPath(fileName: String): String {
        return java.io.File(modelsDir(), fileName).absolutePath
    }

    // JNI methods — implemented in llama-jni.cpp
    external fun nativeLoadModel(path: String, contextLength: Int): Boolean
    external fun nativeUnloadModel()
    external fun nativeIsLoaded(): Boolean
    external fun nativeGetLoadedPath(): String
    external fun nativeChatCompletion(roles: Array<String>, contents: Array<String>): String
}
