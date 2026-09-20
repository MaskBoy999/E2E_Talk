# Consumer rules for the generated Android app.
#
# These are merged into the app module's R8/ProGuard configuration automatically
# (the plugin is an `com.android.library`, see build.gradle.kts).
#
# WEBVIEW CLIENT CALLBACKS
#
# The framework — not app code — calls these methods, so R8 cannot see them
# being used and is free to strip them from a minified release build. That would
# silently remove behaviour the box depends on:
#
#   onReceivedSslError  the pinned-certificate acceptance injected into wry's
#                       generated RustWebViewClient by .cargo/config.toml.
#                       Without it Android cancels the load and the app shows a
#                       blank screen, because the server's certificate is
#                       self-signed.
#   onReceivedError     wry's custom-protocol retry.
#   shouldInterceptRequest / shouldOverrideUrlLoading / onPageStarted /
#   onPageFinished      the daemon/IPC plumbing and the navigation allowlist.
#
# Deliberately `WebViewClient` (not our concrete class) so this keeps working if
# a future wry renames or splits the generated client.
-keepclassmembers class * extends android.webkit.WebViewClient {
    public void onReceivedSslError(android.webkit.WebView, android.webkit.SslErrorHandler, android.net.http.SslError);
    public void onReceivedError(android.webkit.WebView, android.webkit.WebResourceRequest, android.webkit.WebResourceError);
    public android.webkit.WebResourceResponse shouldInterceptRequest(android.webkit.WebView, android.webkit.WebResourceRequest);
    public boolean shouldOverrideUrlLoading(android.webkit.WebView, android.webkit.WebResourceRequest);
    public void onPageStarted(android.webkit.WebView, java.lang.String, android.graphics.Bitmap);
    public void onPageFinished(android.webkit.WebView, java.lang.String);
}

# WebView clients are instantiated from Kotlin/Java, but keep the constructor too
# so obfuscation cannot break the `RustWebViewClient(this, context)` call site.
-keepclassmembers class * extends android.webkit.WebViewClient {
    <init>(...);
}
