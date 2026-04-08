#include <jni.h>
#include <android/log.h>
#include <string>
#include <vector>
#include <mutex>
#include <thread>
#include "llama.h"
#include "ggml-backend.h"

#define TAG "LlamaJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

static llama_model * g_model = nullptr;
static llama_context * g_ctx = nullptr;
static std::string g_loaded_path;
static std::mutex g_mutex;

extern "C" {

// -----------------------------------------------------------------------
// Load / unload
// -----------------------------------------------------------------------

JNIEXPORT jboolean JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeLoadModel(
    JNIEnv *env, jobject, jstring jpath, jint contextLength
) {
    std::lock_guard<std::mutex> lock(g_mutex);

    const char *path = env->GetStringUTFChars(jpath, nullptr);
    std::string pathStr(path);
    env->ReleaseStringUTFChars(jpath, path);

    // Already loaded?
    if (g_model && g_loaded_path == pathStr) {
        LOGI("Model already loaded: %s", pathStr.c_str());
        return JNI_TRUE;
    }

    // Unload any previous model
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_loaded_path.clear();

    // Load all available backends (CPU, etc.)
    ggml_backend_load_all();

    // Load model
    llama_model_params mparams = llama_model_default_params();
    g_model = llama_model_load_from_file(pathStr.c_str(), mparams);
    if (!g_model) {
        LOGE("Failed to load model: %s", pathStr.c_str());
        return JNI_FALSE;
    }

    // Create context
    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = contextLength > 0 ? contextLength : 8192;
    cparams.n_batch = 512;
    cparams.n_threads = std::max(1, (int)std::thread::hardware_concurrency() - 1);

    g_ctx = llama_init_from_model(g_model, cparams);
    if (!g_ctx) {
        LOGE("Failed to create context");
        llama_model_free(g_model);
        g_model = nullptr;
        return JNI_FALSE;
    }

    g_loaded_path = pathStr;
    LOGI("Model loaded: %s (ctx=%d, threads=%d)", pathStr.c_str(),
         cparams.n_ctx, cparams.n_threads);
    return JNI_TRUE;
}

JNIEXPORT void JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeUnloadModel(JNIEnv *, jobject) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_loaded_path.clear();
    LOGI("Model unloaded");
}

JNIEXPORT jboolean JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeIsLoaded(JNIEnv *, jobject) {
    return g_model != nullptr && g_ctx != nullptr ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeGetLoadedPath(JNIEnv *env, jobject) {
    return env->NewStringUTF(g_loaded_path.c_str());
}

// -----------------------------------------------------------------------
// Chat completion
// -----------------------------------------------------------------------

JNIEXPORT jstring JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeChatCompletion(
    JNIEnv *env, jobject,
    jobjectArray jroles, jobjectArray jcontents
) {
    std::lock_guard<std::mutex> lock(g_mutex);

    if (!g_model || !g_ctx) {
        return env->NewStringUTF("[error] No model loaded");
    }

    // Build messages vector
    int msgCount = env->GetArrayLength(jroles);
    std::vector<std::string> roleStrs, contentStrs; // keep strings alive
    roleStrs.reserve(msgCount);
    contentStrs.reserve(msgCount);

    for (int i = 0; i < msgCount; i++) {
        auto jrole    = (jstring)env->GetObjectArrayElement(jroles, i);
        auto jcontent = (jstring)env->GetObjectArrayElement(jcontents, i);
        const char *role    = env->GetStringUTFChars(jrole, nullptr);
        const char *content = env->GetStringUTFChars(jcontent, nullptr);
        roleStrs.emplace_back(role);
        contentStrs.emplace_back(content);
        env->ReleaseStringUTFChars(jrole, role);
        env->ReleaseStringUTFChars(jcontent, content);
    }

    // Build llama_chat_message array (pointers into the std::string storage above)
    std::vector<llama_chat_message> messages;
    messages.reserve(msgCount);
    for (int i = 0; i < msgCount; i++) {
        messages.push_back({roleStrs[i].c_str(), contentStrs[i].c_str()});
    }

    // Apply chat template to get the formatted prompt
    const char *tmpl = llama_model_chat_template(g_model, nullptr);
    std::vector<char> buf(4096);
    int len = llama_chat_apply_template(
        tmpl,
        messages.data(), messages.size(),
        true, buf.data(), (int32_t)buf.size()
    );
    if (len < 0) {
        return env->NewStringUTF("[error] Failed to apply chat template");
    }
    if (len > (int)buf.size()) {
        buf.resize(len + 1);
        len = llama_chat_apply_template(
            tmpl,
            messages.data(), messages.size(),
            true, buf.data(), (int32_t)buf.size()
        );
    }
    std::string prompt(buf.data(), len);

    // Get vocabulary handle
    const llama_vocab *vocab = llama_model_get_vocab(g_model);

    // Tokenize
    int n_ctx = (int)llama_n_ctx(g_ctx);
    std::vector<llama_token> tokens(n_ctx);
    int n_tokens = llama_tokenize(
        vocab,
        prompt.c_str(), (int32_t)prompt.size(),
        tokens.data(), (int32_t)tokens.size(),
        true, true
    );
    if (n_tokens < 0) {
        return env->NewStringUTF("[error] Tokenization failed — prompt may be too long");
    }
    tokens.resize(n_tokens);

    // Clear KV cache for new conversation
    llama_memory_clear(llama_get_memory(g_ctx), false);

    // Decode prompt tokens using batch_get_one
    llama_batch batch = llama_batch_get_one(tokens.data(), n_tokens);
    if (llama_decode(g_ctx, batch) != 0) {
        return env->NewStringUTF("[error] Decode failed");
    }

    // Set up sampler chain
    llama_sampler *sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(0.7f));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.9f, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(42));

    std::string result;
    int max_tokens = 1024;

    for (int i = 0; i < max_tokens; i++) {
        llama_token new_token = llama_sampler_sample(sampler, g_ctx, -1);

        // EOS check
        if (llama_vocab_is_eog(vocab, new_token)) {
            break;
        }

        // Convert token to text
        char piece[128];
        int n = llama_token_to_piece(vocab, new_token, piece, sizeof(piece), 0, true);
        if (n > 0) {
            result.append(piece, n);
        }

        // Decode the next single token
        batch = llama_batch_get_one(&new_token, 1);
        if (llama_decode(g_ctx, batch) != 0) {
            break;
        }
    }

    llama_sampler_free(sampler);

    return env->NewStringUTF(result.c_str());
}

} // extern "C"
