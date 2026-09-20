plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.e2echat.boxshell"
    compileSdk = 34

    defaultConfig {
        minSdk = 29
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
    // WindowInsetsControllerCompat / WindowCompat live here, and they are what
    // make this work on every API level we support (29+) instead of only 30+.
    implementation("androidx.core:core-ktx:1.13.1")
    // `AppCompatActivity.onBackPressedDispatcher` — naming the type requires the
    // dependency, and it is what lets the Back interception attach itself to the
    // activity. Same version the generated app module uses (app/android/
    // build.gradle.kts), so this adds nothing to the APK.
    implementation("androidx.appcompat:appcompat:1.7.1")
    // Provided by the generated Android project (`cargo tauri android init`);
    // carries the `app.tauri.annotation` / `app.tauri.plugin` classes and its
    // consumer ProGuard rules, which keep every `@TauriPlugin` class (so R8
    // cannot strip this plugin out of a minified release build).
    implementation(project(":tauri-android"))
}
