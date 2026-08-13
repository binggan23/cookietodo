plugins {
    id("com.android.library")
    kotlin("android") version "1.9.22"
}

android {
    namespace = "com.cookietodo.plugin.alarm"
    compileSdk = rootProject.ext.get("compileSdkVersion") as Int

    defaultConfig {
        minSdk = rootProject.ext.get("minSdkVersion") as Int
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

repositories {
    google()
    mavenCentral()
}

dependencies {
    api(project(":capacitor-android"))
    api("androidx.security:security-crypto:1.1.0-alpha06")
    api("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.1")
}