# Add project specific ProGuard rules here.
-keep class com.alvr.webclient.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
