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
import android.os.Bundle
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

  override fun onAppWidgetOptionsChanged(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
    updateWidget(context, appWidgetManager, appWidgetId, false)
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
    private const val ACTION_ROTATE_PREVIOUS_NEXT_UP = "com.triority.widget.ROTATE_PREVIOUS_NEXT_UP"

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
        ACTION_ROTATE_PREVIOUS_NEXT_UP -> {
          advanceNextUpIndex(context, -1)
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
      showTemporaryResult(context, if (hasApiKey) "Queued for Triority" else "Task saved")
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
      val clear = prefs.getBoolean("clear", false)
      val widgetWidthDp = widgetWidthDp(appWidgetManager, appWidgetId)

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
      val compactPreview = isPreview && widgetWidthDp < 178
      val compactReview = isReview && widgetWidthDp < 320
      val compactRail = compactPreview || compactReview
      val showPreviewNav = isPreview && nextUpItemCount(context) > 1
      val previewListLabel = previewList.ifBlank { bubbleMeta }
      val previewReminderLabel = if (compactPreview) "" else previewReminder
      val micWidthDp = if (compactRail) 44 else 58
      val bubbleGapDp = if (compactRail) 2 else 7
      val railMaxWidthDp = (widgetWidthDp - micWidthDp - bubbleGapDp - 8).coerceIn(42, 318)
      val previewPaddingDp = if (compactPreview) 9 else 15
      val previewHorizontalPaddingDp = previewPaddingDp
      val previewTopPaddingDp = if (compactPreview) 6 else 8
      val previewBottomPaddingDp = if (compactPreview) 6 else 9
      val previewWidthDp = if (isPreview) {
        previewWidthDp(bubbleText, previewListLabel, previewPriority, previewReminderLabel, railMaxWidthDp, compactPreview)
      } else {
        minOf(260, railMaxWidthDp.coerceAtLeast(58))
      }
      val previewInnerWidthPx = dpToPx(context, (previewWidthDp - (previewHorizontalPaddingDp * 2)).coerceAtLeast(38))
      val bubbleColor = when {
        state == STATE_ERROR -> Color.rgb(255, 118, 110)
        clear && isPreview -> text
        isPreview -> withAlpha(text, 218)
        else -> text
      }
      val submitLabel = if (hasApiKey) "Organize" else "Add"
      val reviewBubbleText = if (compactReview) submitLabel else bubbleText
      val reviewBubbleMeta = if (compactReview) transcript else bubbleMeta
      val panelFill = if (clear) Color.TRANSPARENT else withAlpha(surface, 242)
      val panelStroke = if (clear) Color.TRANSPARENT else withAlpha(accent, 170)
      val previewFill = if (clear) Color.TRANSPARENT else withAlpha(surface, 150)
      val previewStroke = if (clear) Color.TRANSPARENT else withAlpha(accent, 90)
      val controlFill = if (clear) Color.TRANSPARENT else withAlpha(control, 238)
      val controlStroke = if (clear) Color.TRANSPARENT else if (compactReview || isListening) textSub else accent
      val cancelFill = if (clear) Color.TRANSPARENT else withAlpha(control, 210)
      val cancelStroke = if (clear) Color.TRANSPARENT else withAlpha(textSub, 100)
      val submitFill = if (clear) Color.TRANSPARENT else withAlpha(accent, 225)
      val submitStroke = if (clear) Color.TRANSPARENT else withAlpha(Color.WHITE, 80)
      val submitTextColor = if (clear) accent else Color.WHITE
      val micStrokeWidth = if (clear) 0f else 1.5f
      val panelStrokeWidth = if (clear) 0f else 1.3f
      val previewStrokeWidth = if (clear) 0f else 1f
      val buttonStrokeWidth = if (clear) 0f else 1f

      val widgetDirection = if (micSide == "right") View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
      views.setInt(R.id.widget_root, "setLayoutDirection", widgetDirection)
      views.setInt(R.id.widget_bubble, "setLayoutDirection", widgetDirection)
      views.setInt(R.id.widget_preview_panel, "setLayoutDirection", View.LAYOUT_DIRECTION_LTR)
      views.setInt(R.id.widget_review_panel, "setLayoutDirection", View.LAYOUT_DIRECTION_LTR)
      setLayoutWidthDp(views, R.id.widget_mic_button, micWidthDp)
      setLayoutMarginDp(views, R.id.widget_bubble, RemoteViews.MARGIN_START, bubbleGapDp)
      views.setViewVisibility(R.id.widget_bubble, if (isExpanded) View.VISIBLE else View.INVISIBLE)
      views.setViewVisibility(R.id.widget_preview_panel, if (isPreview) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_prev_button, if (showPreviewNav) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_next_button, if (showPreviewNav) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_review_panel, if (isExpanded && !isPreview) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_action_row, if (isReview && !compactReview) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_bubble_meta, if (compactReview && reviewBubbleMeta.isNotBlank()) View.VISIBLE else View.GONE)
      views.setTextViewText(R.id.widget_bubble_text, reviewBubbleText)
      views.setTextViewText(R.id.widget_bubble_meta, reviewBubbleMeta)
      views.setTextViewText(R.id.widget_preview_title, bubbleText)
      views.setTextViewText(R.id.widget_preview_list, previewListLabel)
      views.setTextViewText(R.id.widget_preview_priority, previewPriority)
      views.setTextViewText(R.id.widget_preview_reminder, previewReminder)
      views.setViewPadding(
        R.id.widget_preview_text_stack,
        dpToPx(context, previewHorizontalPaddingDp),
        dpToPx(context, previewTopPaddingDp),
        dpToPx(context, previewHorizontalPaddingDp),
        dpToPx(context, previewBottomPaddingDp),
      )
      views.setTextColor(R.id.widget_bubble_text, bubbleColor)
      views.setTextColor(R.id.widget_bubble_meta, withAlpha(textSub, 230))
      views.setTextColor(R.id.widget_preview_title, bubbleColor)
      views.setTextColor(R.id.widget_preview_prev_button, accent)
      views.setTextColor(R.id.widget_preview_next_button, accent)
      views.setTextColor(R.id.widget_preview_list, accent)
      views.setTextColor(R.id.widget_preview_meta_sep_1, withAlpha(textSub, 165))
      views.setTextColor(R.id.widget_preview_meta_sep_2, withAlpha(textSub, 165))
      views.setTextColor(R.id.widget_preview_priority, previewPriorityColor)
      views.setTextColor(R.id.widget_preview_reminder, withAlpha(textSub, 235))
      val showPreviewReminder = !compactPreview && previewReminder.isNotBlank()
      val showPreviewMeta = previewListLabel.isNotBlank() || previewPriority.isNotBlank() || showPreviewReminder
      val showPreviewMetaRow = showPreviewMeta || showPreviewNav
      views.setViewVisibility(R.id.widget_preview_meta_row, if (showPreviewMetaRow) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_list, if (showPreviewMeta && previewListLabel.isNotBlank()) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_meta_sep_1, if (showPreviewMeta && previewListLabel.isNotBlank() && previewPriority.isNotBlank()) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_priority, if (showPreviewMeta && previewPriority.isNotBlank()) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_meta_sep_2, if (showPreviewReminder && (previewListLabel.isNotBlank() || previewPriority.isNotBlank())) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.widget_preview_reminder, if (showPreviewReminder) View.VISIBLE else View.GONE)
      views.setTextViewText(R.id.widget_submit_text, submitLabel)
      views.setTextColor(R.id.widget_cancel_text, textSub)
      views.setTextColor(R.id.widget_submit_text, submitTextColor)
      views.setTextViewTextSize(R.id.widget_bubble_text, TypedValue.COMPLEX_UNIT_SP, if (compactReview) 12.5f else 13f)
      views.setTextViewTextSize(R.id.widget_bubble_meta, TypedValue.COMPLEX_UNIT_SP, if (compactReview) 9.5f else 10f)
      views.setTextViewTextSize(R.id.widget_cancel_text, TypedValue.COMPLEX_UNIT_SP, 12f)
      views.setTextViewTextSize(R.id.widget_submit_text, TypedValue.COMPLEX_UNIT_SP, 12f)
      views.setTextViewTextSize(R.id.widget_preview_title, TypedValue.COMPLEX_UNIT_SP, if (compactPreview) 13.2f else 15.5f)
      views.setTextViewTextSize(R.id.widget_preview_prev_button, TypedValue.COMPLEX_UNIT_SP, if (compactPreview) 13f else 15f)
      views.setTextViewTextSize(R.id.widget_preview_next_button, TypedValue.COMPLEX_UNIT_SP, if (compactPreview) 13f else 15f)
      views.setTextViewTextSize(R.id.widget_preview_list, TypedValue.COMPLEX_UNIT_SP, if (compactPreview) 9.7f else 11.5f)
      views.setTextViewTextSize(R.id.widget_preview_priority, TypedValue.COMPLEX_UNIT_SP, if (compactPreview) 9.7f else 11.5f)
      views.setTextViewTextSize(R.id.widget_preview_reminder, TypedValue.COMPLEX_UNIT_SP, 11.5f)
      views.setTextViewTextSize(R.id.widget_preview_meta_sep_1, TypedValue.COMPLEX_UNIT_SP, if (compactPreview) 9.5f else 11f)
      views.setTextViewTextSize(R.id.widget_preview_meta_sep_2, TypedValue.COMPLEX_UNIT_SP, 11f)
      views.setInt(R.id.widget_bubble_text, "setMaxLines", if (isPreview || compactReview) 1 else 2)
      views.setInt(R.id.widget_preview_title, "setMaxLines", if (compactPreview && showPreviewMeta) 1 else 2)
      setLayoutWidthDp(views, R.id.widget_preview_panel, previewWidthDp)
      setLayoutWidthDp(views, R.id.widget_preview_bg, previewWidthDp)
      views.setInt(R.id.widget_preview_title, "setMaxWidth", previewInnerWidthPx)
      views.setInt(R.id.widget_preview_list, "setMaxWidth", dpToPx(context, (previewWidthDp * (if (compactPreview) 0.52f else 0.45f)).toInt().coerceIn(if (compactPreview) 34 else 72, if (compactPreview) 96 else 140)))
      views.setInt(R.id.widget_preview_priority, "setMaxWidth", dpToPx(context, (previewWidthDp * (if (compactPreview) 0.34f else 0.28f)).toInt().coerceIn(34, 82)))
      views.setInt(R.id.widget_preview_reminder, "setMaxWidth", dpToPx(context, (previewWidthDp * 0.38f).toInt().coerceIn(62, 118)))

      views.setImageViewBitmap(R.id.widget_mic_bg, roundedRectBitmap(context, controlFill, controlStroke, 20f, micStrokeWidth, 64, 64))
      views.setImageViewBitmap(
        R.id.widget_preview_bg,
        roundedRectBitmap(
          context,
          previewFill,
          previewStroke,
          20f,
          previewStrokeWidth,
          previewWidthDp,
          64,
        )
      )
      views.setImageViewBitmap(R.id.widget_bubble_bg, roundedRectBitmap(context, panelFill, panelStroke, 20f, panelStrokeWidth, 260, 64))
      views.setImageViewBitmap(R.id.widget_cancel_bg, roundedRectBitmap(context, cancelFill, cancelStroke, 14f, buttonStrokeWidth, 68, 38))
      views.setImageViewBitmap(R.id.widget_submit_bg, roundedRectBitmap(context, submitFill, submitStroke, 14f, buttonStrokeWidth, 96, 38))
      views.setImageViewResource(R.id.widget_mic_icon, if (compactReview) R.drawable.ic_widget_close else R.drawable.ic_widget_mic)
      views.setViewVisibility(R.id.widget_sparkle_icon, if (compactReview) View.GONE else View.VISIBLE)
      views.setInt(R.id.widget_mic_icon, "setColorFilter", if (compactReview || isListening) textSub else text)
      views.setInt(R.id.widget_sparkle_icon, "setColorFilter", if (isListening) textSub else accent)

      val cycleIntent = broadcastIntent(context, ACTION_ROTATE_NEXT_UP, 41)
      val previousIntent = broadcastIntent(context, ACTION_ROTATE_PREVIOUS_NEXT_UP, 42)
      val openIntent = nextUpItem?.let { openTaskIntent(context, it) }
      val submitIntent = broadcastIntent(context, ACTION_SUBMIT_TRANSCRIPT, 33)
      val cancelIntent = broadcastIntent(context, ACTION_CANCEL_REVIEW, 31)
      val refreshIntent = broadcastIntent(context, ACTION_REFRESH_WIDGET, 50)
      val previewOpenIntent = openIntent ?: cycleIntent
      val bubbleIntent = when {
        compactReview -> submitIntent
        isPreview -> previewOpenIntent
        else -> refreshIntent
      }
      val micIntent = if (compactReview) cancelIntent else speechIntent(context, appWidgetId)
      val micIconIntent = if (compactReview) cancelIntent else speechIntent(context, appWidgetId + 1000)
      val sparkleIntent = if (compactReview) cancelIntent else speechIntent(context, appWidgetId + 2000)
      views.setOnClickPendingIntent(R.id.widget_bubble, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_panel, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_text_stack, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_title, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_prev_button, previousIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_next_button, cycleIntent)
      views.setOnClickPendingIntent(R.id.widget_review_panel, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_meta_row, previewOpenIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_list, previewOpenIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_priority, previewOpenIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_reminder, previewOpenIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_meta_sep_1, previewOpenIntent)
      views.setOnClickPendingIntent(R.id.widget_preview_meta_sep_2, previewOpenIntent)
      views.setOnClickPendingIntent(R.id.widget_bubble_text_stack, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_bubble_text, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_bubble_meta, bubbleIntent)
      views.setOnClickPendingIntent(R.id.widget_mic_button, micIntent)
      views.setOnClickPendingIntent(R.id.widget_mic_icon, micIconIntent)
      views.setOnClickPendingIntent(R.id.widget_sparkle_icon, sparkleIntent)
      views.setOnClickPendingIntent(R.id.widget_cancel_button, cancelIntent)
      views.setOnClickPendingIntent(R.id.widget_cancel_text, broadcastIntent(context, ACTION_CANCEL_REVIEW, 32))
      views.setOnClickPendingIntent(R.id.widget_submit_button, submitIntent)
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

    private fun advanceNextUpIndex(context: Context, step: Int = 1) {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val count = nextUpItemCount(context)
      if (count < 2) return
      val next = (prefs.getInt(KEY_NEXT_UP_INDEX, 0) + step).floorMod(count)
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

    private fun widgetWidthDp(manager: AppWidgetManager, appWidgetId: Int): Int {
      val options = manager.getAppWidgetOptions(appWidgetId)
      val reportedWidth = maxOf(
        options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0),
        options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0),
      )
      return (if (reportedWidth > 0) reportedWidth else 320).coerceIn(110, 390)
    }

    private fun previewWidthDp(title: String, listName: String, priority: String, reminder: String, maxWidthDp: Int, compact: Boolean): Int {
      val cleanTitle = title.replace(Regex("\\s+"), " ").trim()
      val metaLength = listName.length + priority.length + reminder.length +
        (if (listName.isNotBlank() && priority.isNotBlank()) 3 else 0) +
        (if (reminder.isNotBlank() && (listName.isNotBlank() || priority.isNotBlank())) 3 else 0)
      val longestWord = cleanTitle.split(Regex("\\s+")).maxOfOrNull { it.length } ?: 0
      val estimatedTitleWidth = (cleanTitle.length * (if (compact) 6.8f else 8.2f)).toInt() + (if (compact) 24 else 48)
      val longestWordWidth = (longestWord * (if (compact) 7.4f else 9.2f)).toInt() + (if (compact) 20 else 28)
      val titleWidth = when {
        compact -> maxOf(58, minOf(maxWidthDp, maxOf(estimatedTitleWidth, longestWordWidth)))
        cleanTitle.length <= 10 -> maxOf(128, minOf(maxWidthDp, maxOf(estimatedTitleWidth, longestWordWidth)))
        cleanTitle.length <= 18 -> maxOf(176, minOf(maxWidthDp, maxOf(estimatedTitleWidth, longestWordWidth)))
        cleanTitle.length <= 28 -> maxOf(220, minOf(maxWidthDp, maxOf(estimatedTitleWidth, longestWordWidth)))
        else -> maxWidthDp
      }
      val metaWidth = (metaLength * (if (compact) 5 else 6)) + (if (compact) 24 else 34)
      val minWidth = if (compact) 58 else 120
      return maxOf(minWidth, minOf(maxWidthDp.coerceAtLeast(minWidth), maxOf(titleWidth, metaWidth)))
    }

    private fun dpToPx(context: Context, dp: Int): Int {
      return (dp * context.resources.displayMetrics.density).toInt()
    }

    private fun setLayoutWidthDp(views: RemoteViews, viewId: Int, widthDp: Int) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        views.setViewLayoutWidth(viewId, widthDp.toFloat(), TypedValue.COMPLEX_UNIT_DIP)
      } else {
        views.setInt(viewId, "setMinimumWidth", widthDp)
      }
    }

    private fun setLayoutMarginDp(views: RemoteViews, viewId: Int, marginType: Int, marginDp: Int) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        views.setViewLayoutMargin(viewId, marginType, marginDp.toFloat(), TypedValue.COMPLEX_UNIT_DIP)
      }
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

  override fun onAppWidgetOptionsChanged(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
    TriorityQuickCaptureWidgetProvider.updateNextUp(context)
  }
}
