package expo.modules.nativecloudflare

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class SolveRequest : Record {
    @Field val url: String = ""
    @Field val method: String = "GET"
    @Field val headers: Map<String, String> = emptyMap()
    @Field val body: String? = null
    @Field val captureResponse: Boolean = false
    @Field val userAgent: String = ""
    @Field val timeoutMs: Int = 30_000
    @Field val maxResponseLength: Int = 10 * 1024 * 1024
}

class NativeCloudflareModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("NativeCloudflare")

        AsyncFunction("solveChallenge") { request: SolveRequest, promise: Promise ->
            // The application context keeps this working from the headless
            // background-task service, where no Activity exists.
            val context = appContext.reactContext?.applicationContext
            if (context == null) {
                promise.resolve(SOLVE_FAILED)
                return@AsyncFunction
            }
            CloudflareChallengeSolver(context, request) { result ->
                promise.resolve(result)
            }.start()
        }
    }
}
