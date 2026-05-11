package com.triority

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject

class TriorityQuickCaptureWidgetProvider : AppWidgetProvider() {
  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    handleReceive(context, intent)
  }

  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    appWidgetIds.forEach { updateWidget(context, appWidgetManager, it, false) }
  }

  companion object {
    const val PREFS_NAME = "triority_widget_prefs"
    const val CAPTURE_PREFS_NAME = "triority_widget_capture_prefs"
    const val PENDING_CAPTURES_KEY = "pending_captures"

    const val ACTION_REFRESH_WIDGET = "com.triority.widget.REFRESH"
    private const val ACTION_CANCEL_REVIEW = "com.triority.widget.CANCEL_REVIEW"
    private const val ACTION_SUBMIT_TRANSCRIPT = "com.triority.widget.SUBMIT_TRANSCRIPT"
    private const val ACTION_COLLAPSE_RESULT = "com.triority.widget.COLLAPSE_RESULT"
    private const val ACTION_ROTATE_NEXT_UP = "com.triority.widget.ROTATE_NEXT_UP"

    private const val KEY_STATE = "voiceState"
    private const val KEY_TRANSCRIPT = "voiceTranscript"
    private const val KEY_RESULT_TEXT = "voiceResultText"
    private const val KEY_RESULT_UNTIL = "voiceResultUntil"
    private const val KEY_NEXT_UP_JSON = "nextUpJson"
    private const val KEY_NEXT_UP_INDEX = "nextUpIndex"
    private const val STATE_IDLE = "idle"
    private const val STATE_LISTENING = "listening"
    private const val STATE_REVIEW = "review"
    private const val STATE_SUCCESS = "success"
    private const val STATE_ERROR = "error"
    private const val NEXT_UP_ROTATE_MS = 18_000L

    fun handleReceive(context: Context, intent: Intent) {
      when (intent.action) {
        ACTION_CANCEL_REVIEW -> {
          clearWidgetState(context)
          updateAll(context)
        }
        ACTION_SUBMIT_TRANSCRIPT -> submitTranscript(context)
        ACTION_COLLAPSE_RESULT -> collapseIfCurrent(context, intent.getLongExtra(KEY_RESULT_UNTIL, 0L))
        ACTION_ROTATE_NEXT_UP -> {
          advanceNextUpIndex(context)
          updateNextUp(context)
          scheduleNextUpRotation(context)
        }
        ACTION_REFRESH_WIDGET,
        Intent.ACTION_MY_PACKAGE_REPLACED,
        AppWidgetManager.ACTION_APPWIDGET_UPDATE -> updateAll(context)
      }
    }

    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      updateComponent(context, manager, TriorityQuickCaptureWidgetProvider::class.java, false)
      updateComponent(context, manager, TriorityNextUpWidgetProvider::class.java, true)
      scheduleNextUpRotation(context)
    }

    fun updateNextUp(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      updateComponent(context, manager, TriorityNextUpWidgetProvider::class.java, true)
    }

    private fun updateComponent(context: Context, manager: AppWidgetManager, providerClass: Class<*>, showNextUpPreview: Boolean) {
      val ids = manager.getAppWidgetIds(ComponentName(context, providerClass))
      ids.forEach { updateWidget(context, manager, it, showNextUpPreview) }
    }

    fun showListeningState(context: Context) {
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putString(KEY_STATE, STATE_LISTENING)
        .remove(KEY_TRANSCRIPT)
        .remove(KEY_RESULT_TEXT)
        .remove(KEY_RESULT_UNTIL)
        .apply()
      updateAll(context)
    }

    fun showReviewState(context: Context, transcript: String) {
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putString(KEY_STATE, STATE_REVIEW)
        .putString(KEY_TRANSCRIPT, transcript.trim())
        .remove(KEY_RESULT_TEXT)
        .remove(KEY_RESULT_UNTIL)
        .apply()
      updateAll(context)
    }

    fun showTemporaryResult(context: Context, message: String, durationMs: Long = 4000L) {
      showTemporaryState(context, STATE_SUCCESS, message, durationMs)
    }

    fun showTemporaryError(context: Context, message: String, durationMs: Long = 4000L) {
      showTemporaryState(context, STATE_ERROR, message, durationMs)
    }

    fun clearWidgetState(context: Context) {
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .remove(KEY_STATE)
        .remove(KEY_TRANSCRIPT)
        .remove(KEY_RESULT_TEXT)
        .remove(KEY_RESULT_UNTIL)
        .apply()
    }

    private fun submitTranscript(context: Context) {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val transcript = prefs.getString(KEY_TRANSCRIPT, "")?.trim().orEmpty()
      if (transcript.isBlank()) {
        clearWidgetState(context)
        updateAll(context)
        return
      }

      val hasApiKey = prefs.getBoolean("hasApiKey", false)
      val mode = if (hasApiKey) "ai" else "manual"
      val activeListId = prefs.getString("activeListId", "default") ?: "default"
      queueCapture(context, transcript, mode, activeListId)
      showTemporaryResult(context, if (hasApiKey) "Ready in Triority" else "Task saved")
    }

    private fun queueCapture(context: Context, text: String, mode: String, activeListId: String) {
      val prefs = context.getSharedPreferences(CAPTURE_PREFS_NAME, Context.MODE_PRIVATE)
      val arr = try {
        JSONArray(prefs.getString(PENDING_CAPTURES_KEY, "[]"))
      } catch (_: Throwable) {
        JSONArray()
      }
      arr.put(JSONObject().apply {
        put("id", "widget_${System.currentTimeMillis()}")
        put("text", text)
        put("tier", "medium")
        put("mode", mode)
        put("listId", activeListId)
        put("createdAt", System.currentTimeMillis())
      })
      prefs.edit().putString(PENDING_CAPTURES_KEY, arr.toString()).commit()
    }

    private fun showTemporaryState(context: Context, state: String, message: String, durationMs: Long) {
      val until = System.currentTimeMillis() + durationMs
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putString(KEY_STATE, state)
        .putString(KEY_RESULT_TEXT, message)
        .putLong(KEY_RESULT_UNTIL, until)
        .remove(KEY_TRANSCRIPT)
        .apply()
      updateAll(context)
      scheduleCollapse(context, until)
    }

    private fun collapseIfCurrent(context: Context, expectedUntil: Long) {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val currentUntil = prefs.getLong(KEY_RESULT_UNTIL, 0L)
      if (expectedUntil == currentUntil && currentUntil <= System.currentTimeMillis() + 250L) {
        clearWidgetState(context)
      }
      updateAll(context)
    }

    private fun scheduleCollapse(context: Context, resultUntil: Long) {
      val intent = Intent(context, TriorityQuickCaptureWidgetProvider::class.java).apply {
        action = ACTION_COLLAPSE_RESULT
        putExtra(KEY_RESULT_UNTIL, resultUntil)
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
      val pending = PendingIntent.getBroadcast(context, 78, intent, flags)
      val alarm = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
      alarm?.set(AlarmManager.RTC, resultUntil, pending)
    }

    private fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, showNextUpPreview: Boolean) {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val views = RemoteViews(context.packageName, R.layout.widget_quick_capture)

      val surface = parseColor(prefs.getString("surface", null), Color.rgb(28, 24, 45))
      val control = parseColor(prefs.getString("control", null), Color.rgb(38, 32, 58))
      val accent = parseColor(prefs.getString("accent", null), Color.rgb(214, 95, 190))
      val text = parseColor(prefs.getString("text", null), Color.WHITE)
      val textSub = parseColor(prefs.getString("textSub", null), Color.rgb(196, 178, 220))
      val hasApiKey = prefs.getBoolean("hasApiKey", false)
      val micSide = prefs.getString("micSide", "left") ?: "left"

      var state = prefs.getString(KEY_STATE, STATE_IDLE) ?: STATE_IDLE
      val resultUntil = prefs.getLong(KEY_RESULT_UNTIL, 0L)
      if ((state == STATE_SUCCESS || state == STATE_ERROR) && resultUntil > 0L && resultUntil <= System.currentTimeMillis()) {
        clearWidgetState(context)
        state = STATE_IDLE
      }

      val transcript = prefs.getString(KEY_TRANSCRIPT, "")?.trim().orEmpty()
      if (state == STATE_REVIEW && transcript.isBlank()) state = STATE_IDLE

      val nextUpItem = if (showNextUpPreview && state == STATE_IDLE) currentNextUpItem(prefs) else null
      val isListening = state == STATE_LISTENING
      val isPreview = nextUpItem != null
      val isExpanded = state == STATE_REVIEW || state == STATE_SUCCESS || state == STATE_ERROR || isPreview
      val isReview = state == STATE_REVIEW
      val resultText = prefs.getString(KEY_RESULT_TEXT, "")?.trim().orEmpty()
      val bubbleText = when (state) {
        STATE_REVIEW -> transcript
        STATE_SUCCESS, STATE_ERROR -> resultText
        else -> nextUpItem?.optString("label", "")?.trim().orEmpty()
      }
      val bubbleMeta = nextUpItem?.optString("meta", "")?.trim().orEmpty()
      val previewList = nextUpItem?.optString("listName", "")?.trim().orEmpty()
      val previewPriority = nextUpItem?.optString("priorityLabel", "")?.trim().orEmpty()
      val previewPriorityColor = parseColor(nextUpItem?.optString("priorityColor", ""), accent)
      val previewReminder = nextUpItem?.optString("reminderText", "")?.trim().orEmpty()
      val previewWidthDp = if (isPreview) previewWidthDp(bubbleText, previewList.ifBlank { bubbleMeta }, previewPriority, previewReminder) else 260
      val previewInnerWidthPx = dpToPx(context, (previewWidthDp - 32).coerceAtLeast(88))
      val bubbleColor = when {
        state == STATE_ERROR -> Color.rgb(255, 118, 110)
        isPreview -> withAlpha(text, 218)
        else -> text
      }
      val submitLabel = if (hasApiKey) "\u2728 Organize" else "Add"

      val widgetDirection = if (micSide == "right") View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
      views.setInt(R.id.widget_root, "setLayoutDirection", widgetDirection)
      views.setInt(R.id.widget_bubble, "setLayoutDirection", widgetDirection)
      views.setInt(R.id.widget_preview_panel, "setLayoutDirection", View.LAYOUT_DIRECTION_LTR)
      views.setInt(R.id.widget_review_panel, "setLayoutDirection", View.LAYOUT_DIRECTION_LTR)
      views.setViewVisibility(R.id.widget_bubble, if (isExpanded) View.VISIBLE else View.INVISIBLE)
      views.setViewVisibility(R.id.widget_preview_panel, if (isPreview) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_review_panel, if (isExpanded && !isPreview) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_action_row, if (isReview) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_bubble_meta, if (isPreview && bubbleMeta.isNotBlank()) View.VISIBLE else View.GONE)
      views.setTextViewText(R.id.widget_bubble_text, bubbleText)
      views.setTextViewText(R.id.widget_bubble_meta, bubbleMeta)
      views.setTextViewText(R.id.widget_preview_title, bubbleText)
      views.setTextViewText(R.id.widget_preview_list, previewList.ifBlank { bubbleMeta })
      views.setTextViewText(R.id.widget_preview_priority, previewPriority)
      views.setTextViewText(R.id.widget_preview_reminder, previewReminder)
      views.setTextColor(R.id.widget_bubble_text, bubbleColor)
      views.setTextColor(R.id.widget_bubble_meta, withAlpha(textSub, 230))
      views.setTextColor(R.id.widget_preview_title, bubbleColor)
      views.setTextColor(R.id.widget_preview_list, accent)
      views.setTextColor(R.id.widget_preview_meta_sep_1, withAlpha(textSub, 165))
      views.setTextColor(R.id.widget_preview_meta_sep_2, withAlpha(textSub, 165))
      views.setTextColor(R.id.widget_preview_priority, previewPriorityColor)
      views.setTextColor(R.id.widget_preview_reminder, withAlpha(textSub, 235))
      views.setViewVisibility(R.id.widget_preview_meta_row, if (previewList.isNotBlank() || previewPriority.isNotBlank() || previewReminder.isNotBlank()) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_meta_sep_1, if (previewList.isNotBlank() && previewPriority.isNotBlank()) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_priority, if (previewPriority.isNotBlank()) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_meta_sep_2, if (previewReminder.isNotBlank() && (previewList.isNotBlank() || previewPriority.isNotBlank())) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_reminder, if (previewReminder.isNotBlank()) View.VISIBLE else View.GONE)
      views.setTextViewText(R.id.widget_submit_text, submitLabel)
      views.setTextColor(R.id.widget_cancel_text, textSub)
      views.setTextColor(R.id.widget_submit_text, Color.WHITE)
      views.setTextViewTextSize(R.id.widget_bubble_text, TypedValue.COMPLEX_UNIT_SP, 13f)
      views.setTextViewTextSize(R.id.widget_preview_title, TypedValue.COMPLEX_UNIT_SP, 15.5f)
      views.setInt(R.id.widget_bubble_text, "setMaxLines", if (isPreview) 1 else 2)
      views.setInt(R.id.widget_preview_title, "setMaxLines", 2)
      views.setInt(R.id.widget_preview_title, "setMaxWidth", previewInnerWidthPx)
      views.setInt(R.id.widget_preview_list, "setMaxWidth", dpToPx(context, (previewWidthDp * 0.45f).toInt().coerceIn(72, 140)))
      views.setInt(R.id.widget_preview_reminder, "setMaxWidth", dpToPx(context, (previewWidthDp * 0.38f).toInt().coerceIn(62, 118)))

      views.setImageViewBitmap(R.id.widget_mic_bg, roundedRectBitmap(context, withAlpha(control, 238), if (isListening) textSub else accent, 20f, 1.5f, 64, 64))
      views.setImageViewBitmap(
        R.id.widget_preview_bg,
        roundedRectBitmap(
          context,
          withAlpha(surface, 150),
          withAlpha(accent, 90),
          20f,
          1f,
          previewWidthDp,
          64,
        )
      )
      views.setImageViewBitmap(R.id.widget_bubble_bg, roundedRectBitmap(context, withAlpha(surface, 242), withAlpha(accent, 170), 20f, 1.3f, 260, 64))
      views.setImageViewBitmap(R.id.widget_cancel_bg, roundedRectBitmap(context, withAlpha(control, 210), withAlpha(textSub, 100), 14f, 1f, 80, 30))
      views.setImageViewBitmap(R.id.widget_submit_bg, roundedRectBitmap(context, withAlpha(accent, 225), withAlpha(Color.WHITE, 80), 14f, 1f, 102, 30))
      views.setInt(R.id.widget_mic_icon, "setColorFilter", if (isListening) textSub else text)
      views.setInt(R.id.widget_sparkle_icon, "setColorFilter", if (isListening) textSub else accent)

      val bubbleIntent = nextUpItem?.let { openTaskIntent(context, it) } ?: broadcastIntent(context, ACTION_REFRESH_WIDGET, 50)
      views.setOnClickPendingIntent(R.id.widget_bubble, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_panel, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_text_stack, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_title, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_list, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_priority, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_reminder, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_bubble_text_stack, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_bubble_text, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_bubble_meta, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_mic_button, speechIntent(context, appWidgetId))
      views.setOnClickPendingIntent(R.id.widget_mic_icon, speechIntent(context, appWidgetId + 1000))
      views.setOnClickPendingIntent(R.id.widget_sparkle_icon, speechIntent(context, appWidgetId + 2000))
      views.setOnClickPendingIntent(R.id.widget_cancel_button, broadcastIntent(context, ACTION_CANCEL_REVIEW, 31))
      views.setOnClickPendingIntent(R.id.widget_cancel_text, broadcastIntent(context, ACTION_CANCEL_REVIEW, 32))
      views.setOnClickPendingIntent(R.id.widget_submit_button, broadcastIntent(context, ACTION_SUBMIT_TRANSCRIPT, 33))
      views.setOnClickPendingIntent(R.id.widget_submit_text, broadcastIntent(context, ACTION_SUBMIT_TRANSCRIPT, 34))

      appWidgetManager.updateAppWidget(appWidgetId, views)
    }

    private fun currentNextUpItem(prefs: android.content.SharedPreferences): JSONObject? {
      val arr = try {
        JSONArray(prefs.getString(KEY_NEXT_UP_JSON, "[]") ?: "[]")
      } catch (_: Throwable) {
        JSONArray()
      }
      if (arr.length() == 0) return null
      val index = prefs.getInt(KEY_NEXT_UP_INDEX, 0).floorMod(arr.length())
      return arr.optJSONObject(index)
    }

    private fun advanceNextUpIndex(context: Context) {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val count = nextUpItemCount(context)
      if (count < 2) return
      val next = (prefs.getInt(KEY_NEXT_UP_INDEX, 0) + 1).floorMod(count)
      prefs.edit().putInt(KEY_NEXT_UP_INDEX, next).apply()
    }

    private fun Int.floorMod(divisor: Int): Int {
      if (divisor <= 0) return 0
      val value = this % divisor
      return if (value < 0) value + divisor else value
    }

    private fun nextUpItemCount(context: Context): Int {
      val raw = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(KEY_NEXT_UP_JSON, "[]")
      return try {
        JSONArray(raw ?: "[]").length()
      } catch (_: Throwable) {
        0
      }
    }

    private fun scheduleNextUpRotation(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, TriorityNextUpWidgetProvider::class.java))
      if (ids.isEmpty() || nextUpItemCount(context) < 2) return
      val intent = Intent(context, TriorityNextUpWidgetProvider::class.java).apply {
        action = ACTION_ROTATE_NEXT_UP
      }
      val pending = PendingIntent.getBroadcast(context, 86, intent, PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag())
      val alarm = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
      val at = SystemClock.elapsedRealtime() + NEXT_UP_ROTATE_MS
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          alarm?.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME, at, pending)
        } else {
          alarm?.setExact(AlarmManager.ELAPSED_REALTIME, at, pending)
        }
      } catch (_: Throwable) {
        alarm?.set(AlarmManager.ELAPSED_REALTIME, at, pending)
      }
    }

    private fun speechIntent(context: Context, requestCode: Int): PendingIntent {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val intent = Intent(context, TriorityQuickCaptureActivity::class.java).apply {
        putExtra("activeListId", prefs.getString("activeListId", "default") ?: "default")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      return PendingIntent.getActivity(
        context,
        100 + requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
      )
    }

    private fun openTaskIntent(context: Context, item: JSONObject): PendingIntent {
      val listId = item.optString("listId", "").trim()
      val taskId = item.optString("taskId", "").trim()
      val uri = Uri.Builder()
        .scheme("triority")
        .authority("widget-task")
        .appendQueryParameter("listId", listId)
        .appendQueryParameter("taskId", taskId)
        .build()
      val intent = Intent(context, MainActivity::class.java).apply {
        action = Intent.ACTION_VIEW
        data = uri
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      }
      val requestCode = 4000 + kotlin.math.abs("$listId:$taskId".hashCode() % 100000)
      return PendingIntent.getActivity(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
      )
    }

    private fun broadcastIntent(context: Context, action: String, requestCode: Int): PendingIntent {
      val intent = Intent(context, TriorityQuickCaptureWidgetProvider::class.java).apply {
        this.action = action
      }
      return PendingIntent.getBroadcast(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
      )
    }

    private fun immutableFlag(): Int {
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
    }

    private fun parseColor(value: String?, fallback: Int): Int {
      return try {
        if (value.isNullOrBlank()) {
          fallback
        } else {
          val trimmed = value.trim()
          val cssRgbaHex = Regex("^#[0-9a-fA-F]{8}$")
          val androidColor = if (cssRgbaHex.matches(trimmed)) {
            "#${trimmed.substring(7, 9)}${trimmed.substring(1, 7)}"
          } else {
            trimmed
          }
          Color.parseColor(androidColor)
        }
      } catch (_: Throwable) {
        fallback
      }
    }

    private fun withAlpha(color: Int, alpha: Int): Int {
      return Color.argb(alpha.coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))
    }

    private fun previewWidthDp(title: String, listName: String, priority: String, reminder: String): Int {
      val cleanTitle = title.replace(Regex("\\s+"), " ").trim()
      val metaLength = listName.length + priority.length + reminder.length +
        (if (listName.isNotBlank() && priority.isNotBlank()) 3 else 0) +
        (if (reminder.isNotBlank() && (listName.isNotBlank() || priority.isNotBlank())) 3 else 0)
      val titleWidth = when {
        cleanTitle.length <= 10 -> 118
        cleanTitle.length <= 18 -> 156
        cleanTitle.length <= 28 -> 214
        cleanTitle.length <= 40 -> 270
        else -> 318
      }
      val metaWidth = (metaLength * 6) + 34
      return maxOf(120, minOf(318, maxOf(titleWidth, metaWidth)))
    }

    private fun dpToPx(context: Context, dp: Int): Int {
      return (dp * context.resources.displayMetrics.density).toInt()
    }

    private fun roundedRectBitmap(
      context: Context,
      fill: Int,
      stroke: Int,
      radiusDp: Float,
      strokeDp: Float,
      widthDp: Int,
      heightDp: Int,
    ): Bitmap {
      val density = context.resources.displayMetrics.density
      val width = (widthDp * density).toInt().coerceAtLeast(16)
      val height = (heightDp * density).toInt().coerceAtLeast(16)
      val radius = radiusDp * density
      val strokeWidth = strokeDp * density
      val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap)
      val rect = RectF(strokeWidth / 2f, strokeWidth / 2f, width - strokeWidth / 2f, height - strokeWidth / 2f)
      val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = fill
      }
      canvas.drawRoundRect(rect, radius, radius, paint)
      if (strokeWidth > 0f) {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = strokeWidth
        paint.color = stroke
        canvas.drawRoundRect(rect, radius, radius, paint)
      }
      return bitmap
    }
  }
}

class TriorityNextUpWidgetProvider : AppWidgetProvider() {
  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    TriorityQuickCaptureWidgetProvider.handleReceive(context, intent)
  }

  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    TriorityQuickCaptureWidgetProvider.updateAll(context)
  }
}
