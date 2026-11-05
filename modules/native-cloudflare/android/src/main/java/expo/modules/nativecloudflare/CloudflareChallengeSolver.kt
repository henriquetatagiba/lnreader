package expo.modules.nativecloudflare

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONException
import org.json.JSONObject
import java.util.UUID

internal val SOLVE_FAILED: Map<String, Any?> = mapOf("type" to "failed")
private val SOLVE_CLEARANCE: Map<String, Any?> = mapOf("type" to "clearance")

/**
 * Loads the request in an off-screen WebView so Cloudflare's JavaScript
 * challenge can run, and reports whether a new `cf_clearance` cookie was issued.
 *
 * The WebView shares [CookieManager] with React Native's OkHttp cookie jar, so
 * once this succeeds a plain `fetch` retry carries the clearance cookie. The
 * cookie is bound to the user agent, which is why the caller passes the same one
 * it sends with `fetch`.
 *
 * Some sites block the app's own requests but let the WebView through without
 * ever issuing a clearance. When [SolveRequest.captureResponse] is set, the
 * request is then answered from inside the WebView instead: a GET returns the
 * loaded document, and other methods are replayed with `fetch` from the site's
 * root page.
 *
 * Detection mirrors Mihon's CloudflareInterceptor: the challenge is identified
 * by the documented `cf-mitigated: challenge` header, and an interactive
 * (Turnstile checkbox) challenge aborts early because it cannot be solved
 * without the user.
 */
internal class CloudflareChallengeSolver(
    private val context: Context,
    private val request: SolveRequest,
    private val onDone: (Map<String, Any?>) -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val cookieManager: CookieManager by lazy { CookieManager.getInstance() }
    private val timeout = Runnable { finish(SOLVE_FAILED) }

    // Only this solver's replay script knows it, so another frame on the page
    // cannot hand back a response.
    private val responseToken = UUID.randomUUID().toString()

    // A WebView can only navigate with GET, and the clearance covers the whole
    // site, so other methods load the root page and are replayed from there.
    private val pageUrl =
        if (request.method == "GET") {
            request.url
        } else {
            Uri.parse(request.url).buildUpon()
                .encodedPath("/")
                .clearQuery()
                .fragment(null)
                .build()
                .toString()
        }

    private var webView: WebView? = null
    private var previousClearance: String? = null

    // Set when the main-frame response being loaded is a challenge page, and
    // consumed when that page finishes, so every load (including one reached
    // through a redirect) is judged on its own response.
    private var pageChallenged = false
    private var capturing = false
    private var rendererGone = false
    private var finished = false

    fun start() {
        mainHandler.post {
            try {
                previousClearance = readClearance()
                webView = createWebView()
                mainHandler.postDelayed(timeout, request.timeoutMs.toLong())
                webView?.loadUrl(pageUrl, request.headers)
            } catch (_: Exception) {
                // WebView can be missing or mid-update on some devices.
                finish(SOLVE_FAILED)
            }
        }
    }

    private fun readClearance(): String? =
        cookieManager.getCookie(request.url)
            ?.split(';')
            ?.map { it.trim() }
            ?.firstOrNull { it.startsWith("$CLEARANCE_COOKIE=") }
            ?.substringAfter('=')

    private fun isSolved(): Boolean {
        val clearance = readClearance()
        return clearance != null && clearance != previousClearance
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView =
        WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.userAgentString = request.userAgent
            cookieManager.setAcceptCookie(true)
            cookieManager.setAcceptThirdPartyCookies(this, true)
            addJavascriptInterface(Bridge(), JS_INTERFACE)
            webViewClient = ChallengeClient()
        }

    private fun finish(result: Map<String, Any?>) {
        if (finished) return
        finished = true
        mainHandler.removeCallbacks(timeout)
        if (result["type"] == "clearance") {
            cookieManager.flush()
        }
        webView?.run {
            // Only destroy can be called on a WebView whose renderer is gone.
            if (!rendererGone) stopLoading()
            destroy()
        }
        webView = null
        onDone(result)
    }

    private fun finishWithoutChallenge() {
        finish(if (isSolved()) SOLVE_CLEARANCE else SOLVE_FAILED)
    }

    private fun captureResponse(view: WebView) {
        capturing = true
        if (request.method == "GET") {
            view.evaluateJavascript(documentScript()) { json -> finish(toResponse(json)) }
        } else {
            view.evaluateJavascript(replayScript(), null)
        }
    }

    private fun documentScript() =
        """
        (function () {
          var contentType = document.contentType || "text/html";
          var textOnly = /json|text\/plain|javascript|csv/i.test(contentType);
          var body = (textOnly && document.body
            ? document.body.innerText
            : document.documentElement.outerHTML) || "";
          if (body.length > ${request.maxResponseLength}) {
            return { error: "The page exceeded the maximum response size." };
          }
          return {
            status: 200,
            statusText: "OK",
            url: location.href,
            headers: { "content-type": contentType },
            body: body
          };
        })();
        """.trimIndent()

    private fun replayScript(): String {
        val payload = JSONObject()
            .put("token", responseToken)
            .put("url", request.url)
            .put("method", request.method)
            .put("headers", JSONObject(request.headers))
            .put("body", request.body ?: JSONObject.NULL)
            .put("maxResponseLength", request.maxResponseLength)
        return """
            (function (p) {
              function send(result) {
                $JS_INTERFACE.deliverResponse(p.token, JSON.stringify(result));
              }
              fetch(p.url, {
                method: p.method,
                headers: p.headers,
                body: p.body,
                credentials: "include"
              })
                .then(function (response) {
                  return response.text().then(function (body) {
                    if (body.length > p.maxResponseLength) {
                      send({ error: "The response exceeded the maximum size." });
                      return;
                    }
                    var headers = {};
                    response.headers.forEach(function (value, name) {
                      headers[name] = value;
                    });
                    send({
                      status: response.status,
                      statusText: response.statusText,
                      url: response.url,
                      headers: headers,
                      body: body
                    });
                  });
                })
                .catch(function (error) {
                  send({ error: String(error) });
                });
            })($payload);
        """.trimIndent()
    }

    private fun toResponse(json: String?): Map<String, Any?> {
        val result = try {
            JSONObject(json ?: return SOLVE_FAILED)
        } catch (_: JSONException) {
            return SOLVE_FAILED
        }
        if (result.has("error")) return SOLVE_FAILED

        val headers = result.optJSONObject("headers")
        return mapOf(
            "type" to "response",
            "status" to result.optInt("status", 200),
            "statusText" to result.optString("statusText"),
            "url" to result.optString("url", request.url),
            "headers" to headers?.keys()?.asSequence()?.associateWith { headers.optString(it) }.orEmpty(),
            "body" to result.optString("body"),
        )
    }

    private inner class ChallengeClient : WebViewClient() {
        override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            errorResponse: WebResourceResponse,
        ) {
            if (!request.isForMainFrame) return
            val mitigated = errorResponse.responseHeaders
                ?.entries
                ?.firstOrNull { it.key.equals("cf-mitigated", ignoreCase = true) }
                ?.value
            if (mitigated == "challenge") {
                pageChallenged = true
            } else {
                // A plain error page (e.g. a firewall block) will not turn into a
                // clearance, but the challenge may already have issued one.
                finishWithoutChallenge()
            }
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            if (request.isForMainFrame) {
                finishWithoutChallenge()
            }
        }

        override fun onPageFinished(view: WebView, loadedUrl: String) {
            if (finished || capturing) return
            if (isSolved()) {
                finish(SOLVE_CLEARANCE)
                return
            }
            val challenged = pageChallenged
            pageChallenged = false
            if (challenged) {
                view.evaluateJavascript(INTERACTIVE_LISTENER, null)
                return
            }
            // This page loaded without a challenge (also after a redirect), so
            // no clearance is coming.
            if (request.captureResponse) {
                captureResponse(view)
            } else {
                finish(SOLVE_FAILED)
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // Not handling it kills the app; failing the solve is enough.
            rendererGone = true
            finish(SOLVE_FAILED)
            return true
        }
    }

    private inner class Bridge {
        @Suppress("unused")
        @JavascriptInterface
        fun interactiveDetected() {
            mainHandler.post { finish(SOLVE_FAILED) }
        }

        @Suppress("unused")
        @JavascriptInterface
        fun deliverResponse(token: String, json: String) {
            if (token != responseToken) return
            mainHandler.post { finish(toResponse(json)) }
        }
    }

    private companion object {
        const val CLEARANCE_COOKIE = "cf_clearance"
        const val JS_INTERFACE = "lnreaderCloudflare"
        val INTERACTIVE_LISTENER = """
            addEventListener("message", ({ data }) => {
              if (data?.source === "cloudflare-challenge" && data?.event === "interactiveBegin") {
                $JS_INTERFACE.interactiveDetected();
              }
            });
        """.trimIndent()
    }
}
