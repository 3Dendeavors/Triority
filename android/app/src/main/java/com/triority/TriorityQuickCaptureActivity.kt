package com.triority

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.speech.RecognizerIntent
import android.view.Gravity
import android.view.Window
import android.view.WindowManager

class TriorityQuickCaptureActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    super.onCreate(savedInstanceState)
    window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
    window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
    window.setGravity(Gravity.TOP or Gravity.START)
    window.setLayout(1, 1)
    startVoiceCapture()
  }

  private fun startVoiceCapture() {
    TriorityQuickCaptureWidgetProvider.showListeningState(this)
    val speechIntent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak a thought for Triority")
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 5000)
      putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 9000)
      putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 14000)
    }
    try {
      startActivityForResult(speechIntent, REQUEST_SPEECH)
    } catch (_: ActivityNotFoundException) {
      TriorityQuickCaptureWidgetProvider.showTemporaryError(this, "Voice unavailable")
      finish()
    } catch (_: Throwable) {
      TriorityQuickCaptureWidgetProvider.showTemporaryError(this, "Voice did not start")
      finish()
    }
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQUEST_SPEECH) {
      finish()
      return
    }

    if (resultCode != RESULT_OK) {
      TriorityQuickCaptureWidgetProvider.clearWidgetState(this)
      TriorityQuickCaptureWidgetProvider.updateAll(this)
      finish()
      return
    }

    val transcript = data
      ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
      ?.firstOrNull()
      ?.trim()
      .orEmpty()

    if (transcript.isBlank()) {
      TriorityQuickCaptureWidgetProvider.showTemporaryError(this, "Nothing captured")
    } else {
      TriorityQuickCaptureWidgetProvider.showReviewState(this, transcript)
    }
    finish()
  }

  companion object {
    private const val REQUEST_SPEECH = 4107
  }
}
