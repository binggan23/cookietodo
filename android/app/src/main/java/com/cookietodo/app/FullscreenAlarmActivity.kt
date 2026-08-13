package com.cookietodo.app

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.cookietodo.plugin.alarm.CookietodoAlarmPlugin

/**
 * Fullscreen alarm activity launched by AlarmManager when a scheduled
 * alarm fires. Overrides lock screen and keeps screen on. Renders a
 * password pad for dismiss (6-digit) and a snooze button.
 *
 * Architecture:
 *   - AlarmManager → PendingIntent with FLAG_ACTIVITY_NEW_TASK
 *     launches this activity.
 *   - Reads the dismiss password from EncryptedSharedPreferences
 *     (same store the CapacitorDeviceAdapter TS bridge writes to).
 *   - On valid password → calls CookietodoAlarmPlugin.notifyAlarmDismissed
 *     which fires notifyListeners("alarmDismissed") to the web renderer.
 *   - On snooze → fires notifyListeners("alarmSnoozed").
 *   - After 3 snoozes the snooze button is hidden (ADR 0007 Decision C).
 *   - Follows system dark mode (Configuration.UI_MODE_NIGHT_YES).
 */
class FullscreenAlarmActivity : AppCompatActivity() {

    companion object {
        private const val PREFS_NAME = "cookietodo_secure_prefs"
        private const val KEY_DISMISS_PASSWORD = "dismiss_password"
        private const val MAX_SNOOZES = 3
    }

    private var reminderId: String = ""
    private var todoId: String = ""
    private var todoTitle: String = ""
    private var snoozeCount: Int = 0

    private lateinit var passwordDisplay: TextView
    private lateinit var statusText: TextView
    private lateinit var snoozeButton: Button

    // In-memory pad state
    private val enteredDigits = mutableListOf<Char>()

    private var mediaPlayer: MediaPlayer? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Fullscreen flags
        window.addFlags(
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
        )

        // Force fullscreen immersive
        supportActionBar?.hide()
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )

        // Read extras
        reminderId = intent.getStringExtra("reminderId") ?: ""
        todoId = intent.getStringExtra("todoId") ?: ""
        todoTitle = intent.getStringExtra("todoTitle") ?: "Alarm"
        snoozeCount = intent.getIntExtra("snoozeCount", 0)

        // Notify the plugin that the alarm has fired
        CookietodoAlarmPlugin.instance?.notifyAlarmFired(reminderId, todoId, todoTitle)

        // Build UI
        buildAlarmUI()

        // Start alarm ringtone
        startAlarmTone()

        // Acquire partial wake lock to stay alive
        acquireWakeLock()
    }

    private fun buildAlarmUI() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.MATCH_PARENT
            )
        }

        // Dark mode background
        val isDarkMode = (resources.configuration.uiMode and
            Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        root.setBackgroundColor(
            if (isDarkMode) 0xFF121212.toInt() else 0xFFF5F5F5.toInt()
        )

        // Todo title
        val titleView = TextView(this).apply {
            text = todoTitle
            textSize = 28f
            setTextColor(
                if (isDarkMode) 0xFFFFFFFF.toInt() else 0xFF000000.toInt()
            )
            gravity = Gravity.CENTER
            setPadding(32, 32, 32, 16)
        }
        root.addView(titleView)

        // Status text
        statusText = TextView(this).apply {
            text = "Enter password to dismiss"
            textSize = 16f
            setTextColor(
                if (isDarkMode) 0xFFBBBBBB.toInt() else 0xFF666666.toInt()
            )
            gravity = Gravity.CENTER
            setPadding(32, 8, 32, 24)
        }
        root.addView(statusText)

        // Password display (6 dashes)
        passwordDisplay = TextView(this).apply {
            text = "------"
            textSize = 36f
            setTextColor(
                if (isDarkMode) 0xFFFFFFFF.toInt() else 0xFF000000.toInt()
            )
            gravity = Gravity.CENTER
            letterSpacing = 0.3f
            setPadding(32, 8, 32, 32)
        }
        root.addView(passwordDisplay)

        // Digit pad grid
        val padLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
        }

        val digits = listOf(
            listOf("1", "2", "3"),
            listOf("4", "5", "6"),
            listOf("7", "8", "9"),
            listOf("⌫", "0", "✓")
        )

        for (row in digits) {
            val rowLayout = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
            }
            for (label in row) {
                val button = Button(this).apply {
                    text = label
                    textSize = 24f
                    setPadding(24, 16, 24, 16)
                    val btnParams = LinearLayout.LayoutParams(
                        120,
                        120
                    ).apply {
                        setMargins(8, 8, 8, 8)
                    }
                    layoutParams = btnParams
                    setOnClickListener { onDigitPress(label) }
                }
                rowLayout.addView(button)
            }
            padLayout.addView(rowLayout)
        }
        root.addView(padLayout)

        // Snooze button
        snoozeButton = Button(this).apply {
            text = "Snooze (10 min)"
            textSize = 18f
            setPadding(32, 16, 32, 16)
            val btnParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = 32
            }
            layoutParams = btnParams
            setOnClickListener { onSnooze() }
            // Hide after MAX_SNOOZES
            if (snoozeCount >= MAX_SNOOZES) {
                visibility = View.GONE
            }
        }
        root.addView(snoozeButton)

        setContentView(root)
    }

    private fun onDigitPress(label: String) {
        when (label) {
            "⌫" -> {
                if (enteredDigits.isNotEmpty()) {
                    enteredDigits.removeAt(enteredDigits.lastIndex)
                }
            }
            "✓" -> {
                checkPassword()
            }
            else -> {
                if (enteredDigits.size < 6) {
                    enteredDigits.add(label[0])
                }
            }
        }
        updatePasswordDisplay()
    }

    private fun updatePasswordDisplay() {
        val display = enteredDigits.joinToString("") +
            "-".repeat(6 - enteredDigits.size)
        passwordDisplay.text = display
    }

    private fun checkPassword() {
        if (enteredDigits.size != 6) {
            statusText.text = "Enter all 6 digits"
            return
        }

        val entered = enteredDigits.joinToString("")
        val storedPassword = readDismissPassword()

        if (storedPassword == entered) {
            dismiss()
        } else {
            statusText.text = "Wrong password"
            enteredDigits.clear()
            updatePasswordDisplay()
        }
    }

    private fun dismiss() {
        stopAlarmTone()
        releaseWakeLock()
        CookietodoAlarmPlugin.instance?.notifyAlarmDismissed(reminderId)
        finishAndRemoveTask()
    }

    private fun onSnooze() {
        stopAlarmTone()
        releaseWakeLock()
        CookietodoAlarmPlugin.instance?.notifyAlarmSnoozed(reminderId)
        finishAndRemoveTask()
    }

    private fun readDismissPassword(): String {
        return try {
            val masterKey = MasterKey.Builder(this)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()

            val prefs = EncryptedSharedPreferences.create(
                this,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            prefs.getString(KEY_DISMISS_PASSWORD, "") ?: ""
        } catch (_: Exception) {
            ""
        }
    }

    private fun startAlarmTone() {
        try {
            val uri: Uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            mediaPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build()
                )
                setDataSource(this@FullscreenAlarmActivity, uri)
                isLooping = true
                prepare()
                start()
            }
        } catch (_: Exception) {
            // Silent fallback if ringtone cannot play
        }
    }

    private fun stopAlarmTone() {
        try {
            mediaPlayer?.apply {
                if (isPlaying) stop()
                release()
            }
        } catch (_: Exception) {
            // ignore
        }
        mediaPlayer = null
    }

    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "cookietodo:alarm_wakelock"
            ).apply {
                acquire(10 * 60 * 1000L) // max 10 minutes
            }
        } catch (_: Exception) {
            // ignore
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.apply {
                if (isHeld) release()
            }
        } catch (_: Exception) {
            // ignore
        }
        wakeLock = null
    }

    override fun onBackPressed() {
        // Back does nothing on alarm screen — user must dismiss or snooze
    }

    override fun onDestroy() {
        stopAlarmTone()
        releaseWakeLock()
        super.onDestroy()
    }
}