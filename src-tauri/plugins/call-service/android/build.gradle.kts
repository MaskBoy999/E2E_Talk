plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.e2echat.callservice"
    compileSdk = 34

    defaultConfig {
        minSdk = 29
        // Merged into the app module's R8 config. Keeps the WebViewClient
        // callbacks the framework (not app code) invokes — including the
        // pinned-certificate acceptance injected into wry's generated
        // RustWebViewClient by .cargo/config.toml, which a minified release
        // build would otherwise be free to strip.
        consumerProguardFiles("consumer-proguard-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    // `androidx.activity.result.ActivityResult` — the type of the system
    // picker's answer handed to our `@ActivityCallback`. `compileOnly` because
    // the *type* is all we need: the app always has this artifact at runtime
    // (Tauri's own `PluginManager` registers its launchers with it), and
    // declaring it as a real dependency would bump the app's resolved version
    // for no reason. 1.6.0 is what this module already resolves to (tauri-android
    // depends on appcompat 1.6.0); naming any other version fights Gradle's
    // consistent resolution and fails the build outright.
    compileOnly("androidx.activity:activity:1.6.0")
    // Provided by the generated Android project (`cargo tauri android init`).
    implementation(project(":tauri-android"))
}
