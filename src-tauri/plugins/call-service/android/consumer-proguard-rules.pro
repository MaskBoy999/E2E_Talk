# ── The Kotlin plugin classes are reached by NAME, so R8 cannot see them ──
#
# Rust resolves this plugin with `find_class("com/e2echat/callservice/…")` from
# a string, and PluginHandle then invokes the `@Command` / `@ActivityCallback`
# methods by reflection. R8 sees no reference to any of it, which makes both the
# class names and the annotated methods fair game for renaming and stripping in
# a minified release — and the failure is not a broken feature but a launch that
# dies while building the plugin (`find_class` throws). That is a release-only
# crash you cannot reproduce from a debug build, so the names are pinned here.
-keep class com.e2echat.callservice.** { *; }

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

# ── WebChromeClient: screen capture (getDisplayMedia) ──────────────────
#
# The onPermissionRequest override injected by .cargo/config.toml must survive
# R8/ProGuard in release builds, otherwise screen sharing (getDisplayMedia) fails
# silently on Android because the MediaProjection request is auto-denied.
-keepclassmembers class * extends android.webkit.WebChromeClient {
    public void onPermissionRequest(android.webkit.PermissionRequest);
}
-keepclassmembers class * extends android.webkit.WebChromeClient {
    <init>(...);
}
