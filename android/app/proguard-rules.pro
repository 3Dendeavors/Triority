# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# react-native-speech-recognition-kit — TurboModule + native event emitter
-keep class com.speechrecognition.** { *; }

# react-native-vector-icons — keep font asset names so getImageSourceSync works
-keep class com.reactnativevectoricons.** { *; }

# react-native-gesture-handler
-keep class com.swmansion.gesturehandler.** { *; }

# react-native-safe-area-context
-keep class com.th3rdwave.safeareacontext.** { *; }

# AsyncStorage
-keep class com.reactnativecommunity.asyncstorage.** { *; }

# Hermes — strip nothing from Hermes runtime
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }

# React Native — keep all native module entry points and codegen specs
-keep class com.facebook.react.turbomodule.** { *; }
-keepclassmembers class * extends com.facebook.react.bridge.NativeModule {
    @com.facebook.react.bridge.ReactMethod <methods>;
}

# react-native-encrypted-storage — Tink cryptography library
-keep class com.google.crypto.tink.** { *; }
-keep class com.google.errorprone.annotations.** { *; }
-keep class com.reactnativesecurestorage.** { *; }
-dontwarn com.google.errorprone.annotations.**

# Notifee — local notifications, foreground service, AlarmManager triggers
-keep class app.notifee.** { *; }
-dontwarn app.notifee.**

# RevenueCat — react-native-purchases
-keep class com.revenuecat.purchases.** { *; }
-dontwarn com.google.api.client.**
-dontwarn com.google.crypto.tink.util.KeysDownloader

