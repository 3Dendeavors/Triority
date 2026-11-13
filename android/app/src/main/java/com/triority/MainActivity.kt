package com.triority

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    handleWidgetCapture(intent)
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    handleWidgetCapture(intent)
    super.onNewIntent(intent)
  }

  private fun handleWidgetCapture(intent: Intent?) {
    if (intent?.getBooleanExtra(TriorityQuickCaptureWidgetProvider.EXTRA_SUBMIT_CAPTURE, false) == true) {
      intent.removeExtra(TriorityQuickCaptureWidgetProvider.EXTRA_SUBMIT_CAPTURE)
      TriorityQuickCaptureWidgetProvider.submitTranscript(this)
    }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Triority"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
