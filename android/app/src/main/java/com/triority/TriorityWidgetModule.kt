package com.triority

import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap

class TriorityWidgetModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "TriorityWidget"

  @ReactMethod
  fun updateWidgetTheme(payload: ReadableMap) {
    val editor = reactContext
      .getSharedPreferences(TriorityQuickCaptureWidgetProvider.PREFS_NAME, Context.MODE_PRIVATE)
      .edit()

    putStringIfPresent(editor, payload, "background")
    putStringIfPresent(editor, payload, "surface")
    putStringIfPresent(editor, payload, "control")
    putStringIfPresent(editor, payload, "accent")
    putStringIfPresent(editor, payload, "text")
    putStringIfPresent(editor, payload, "textSub")
    putStringIfPresent(editor, payload, "activeListName")
    putStringIfPresent(editor, payload, "activeListId")
    putStringIfPresent(editor, payload, "nextUpJson")
    putStringIfPresent(editor, payload, "micSide")
    if (payload.hasKey("hasApiKey") && !payload.isNull("hasApiKey")) {
      editor.putBoolean("hasApiKey", payload.getBoolean("hasApiKey"))
    }
    editor.commit()
    TriorityQuickCaptureWidgetProvider.updateAll(reactContext)
  }

  @ReactMethod
  fun consumePendingCaptures(promise: Promise) {
    try {
      val prefs = reactContext.getSharedPreferences(TriorityQuickCaptureWidgetProvider.CAPTURE_PREFS_NAME, Context.MODE_PRIVATE)
      val pending = prefs.getString(TriorityQuickCaptureWidgetProvider.PENDING_CAPTURES_KEY, "[]") ?: "[]"
      prefs.edit().putString(TriorityQuickCaptureWidgetProvider.PENDING_CAPTURES_KEY, "[]").commit()
      promise.resolve(pending)
    } catch (e: Throwable) {
      promise.reject("widget_capture_consume_failed", e)
    }
  }

  @ReactMethod
  fun showWidgetResult(message: String) {
    TriorityQuickCaptureWidgetProvider.showTemporaryResult(reactContext, message)
  }

  private fun putStringIfPresent(editor: android.content.SharedPreferences.Editor, payload: ReadableMap, key: String) {
    if (payload.hasKey(key) && !payload.isNull(key)) {
      editor.putString(key, payload.getString(key))
    }
  }
}
