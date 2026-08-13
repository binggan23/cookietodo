package com.cookietodo.plugin.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "CookietodoAlarm",
    permissions = [
        Permission(
            alias = "scheduleExactAlarm",
            strings = ["android.permission.SCHEDULE_EXACT_ALARM"]
        ),
        Permission(
            alias = "useFullScreenIntent",
            strings = ["android.permission.USE_FULL_SCREEN_INTENT"]
        ),
        Permission(
            alias = "systemAlertWindow",
            strings = ["android.permission.SYSTEM_ALERT_WINDOW"]
        ),
        Permission(
            alias = "postNotifications",
            strings = ["android.permission.POST_NOTIFICATIONS"]
        )
    ]
)
class CookietodoAlarmPlugin : Plugin() {

    companion object {
        /** Singleton instance so FullscreenAlarmActivity can fire events. */
        var instance: CookietodoAlarmPlugin? = null

        private const val PREFS_NAME = "cookietodo_secure_prefs"
        private const val KEY_DISMISS_PASSWORD = "dismiss_password"
        private const val KEY_WEBDAV_PREFIX = "webdav_"
        private const val REQUEST_CODE_BASE = 1000
        private const val ALARM_ACTION = "com.cookietodo.app.ACTION_ALARM_FIRED"
        private const val FULLSCREEN_CLASS = "com.cookietodo.app.FullscreenAlarmActivity"
    }

    private lateinit var alarmManager: AlarmManager

    override fun load() {
        instance = this
        alarmManager = activity?.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        super.load()
    }

    // ── Alarm scheduling ──────────────────────────────────────────────────

    @PluginMethod
    fun schedule(call: com.getcapacitor.PluginCall) {
        val reminder = call.getObject("reminder")
        val todo = call.getObject("todo")

        val reminderId = reminder.getString("id") ?: return call.reject("reminder.id is required")
        val todoId = todo.getString("id") ?: return call.reject("todo.id is required")
        val todoTitle = todo.getString("title") ?: ""
        val triggerAt = reminder.getLong("triggerAt")

        if (triggerAt == null) {
            return call.reject("reminder.triggerAt is required")
        }

        val context = activity ?: return call.reject("Activity context not available")

        val intent = createAlarmIntent(context, reminderId, todoId, todoTitle, triggerAt)
        val requestCode = toRequestCode(reminderId)

        val pendingIntent = PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        alarmManager.setExactAndAllowWhileIdle(
            AlarmManager.RTC_WAKEUP,
            triggerAt,
            pendingIntent
        )

        val serviceIntent = Intent(context, CookietodoAlarmForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }

        call.resolve()
    }

    @PluginMethod
    fun cancel(call: com.getcapacitor.PluginCall) {
        val reminderId = call.getString("reminderId") ?: return call.reject("reminderId is required")
        val context = activity ?: return call.reject("Activity context not available")

        val intent = Intent(ALARM_ACTION).apply {
            setPackage(context.packageName)
        }
        val requestCode = toRequestCode(reminderId)

        val pendingIntent = PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        alarmManager.cancel(pendingIntent)
        pendingIntent.cancel()

        call.resolve()
    }

    // ── Alarm lifecycle events ────────────────────────────────────────────

    @PluginMethod
    fun dismissAlarm(call: com.getcapacitor.PluginCall) {
        val reminderId = call.getString("reminderId") ?: return call.reject("reminderId is required")

        val data = JSObject().apply {
            put("reminderId", reminderId)
        }
        notifyListeners("alarmDismissed", data)
        call.resolve()
    }

    @PluginMethod
    fun snoozeAlarm(call: com.getcapacitor.PluginCall) {
        val reminderId = call.getString("reminderId") ?: return call.reject("reminderId is required")

        val data = JSObject().apply {
            put("reminderId", reminderId)
        }
        notifyListeners("alarmSnoozed", data)
        call.resolve()
    }

    @PluginMethod
    fun closeAlarmWindow(call: com.getcapacitor.PluginCall) {
        val reminderId = call.getString("reminderId") ?: return call.reject("reminderId is required")

        val data = JSObject().apply {
            put("reminderId", reminderId)
        }
        notifyListeners("alarmWindowClosed", data)
        call.resolve()
    }

    /** Bridge — called from FullscreenAlarmActivity when alarm fires. */
    fun notifyAlarmFired(reminderId: String, todoId: String, todoTitle: String) {
        val data = JSObject().apply {
            put("reminderId", reminderId)
            put("todoId", todoId)
            put("todoTitle", todoTitle)
        }
        notifyListeners("alarmFired", data)
    }

    /** Bridge — called from FullscreenAlarmActivity on dismiss. */
    fun notifyAlarmDismissed(reminderId: String) {
        val data = JSObject().apply {
            put("reminderId", reminderId)
        }
        notifyListeners("alarmDismissed", data)
    }

    /** Bridge — called from FullscreenAlarmActivity on snooze. */
    fun notifyAlarmSnoozed(reminderId: String) {
        val data = JSObject().apply {
            put("reminderId", reminderId)
        }
        notifyListeners("alarmSnoozed", data)
    }

    // ── Permission handling ───────────────────────────────────────────────

    @PluginMethod
    fun requestPermission(call: com.getcapacitor.PluginCall) {
        val kind = call.getString("kind", "alarm")
        val context = activity ?: return call.reject("Activity context not available")

        when (kind) {
            "alarm" -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    val alarmIntent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                        data = android.net.Uri.parse("package:${context.packageName}")
                    }
                    context.startActivity(alarmIntent)
                }
                call.resolve(JSObject().apply { put("result", "granted") })
            }
            "notification" -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    requestPermissionForAlias("postNotifications", call, "notificationCallback")
                } else {
                    call.resolve(JSObject().apply { put("result", "granted") })
                }
            }
            else -> call.reject("Unknown permission kind: $kind")
        }
    }

    @PermissionCallback
    fun notificationCallback(call: com.getcapacitor.PluginCall) {
        val context = activity ?: run {
            call.reject("Activity context not available")
            return
        }

        val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context,
                android.Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }

        call.resolve(JSObject().apply { put("result", if (granted) "granted" else "denied") })
    }

    // ── Secure storage (used by CapacitorDeviceAdapter TS bridge) ─────────

    @PluginMethod
    fun getDismissPassword(call: com.getcapacitor.PluginCall) {
        val password = readSecurePreference(KEY_DISMISS_PASSWORD)
        call.resolve(JSObject().apply {
            if (password != null) {
                put("password", password)
            }
        })
    }

    @PluginMethod
    fun saveDismissPassword(call: com.getcapacitor.PluginCall) {
        val password = call.getString("password") ?: return call.reject("password is required")
        writeSecurePreference(KEY_DISMISS_PASSWORD, password)
        call.resolve()
    }

    @PluginMethod
    fun getWebDAVCredentials(call: com.getcapacitor.PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        val key = "${KEY_WEBDAV_PREFIX}${url}"
        val raw = readSecurePreference(key)
        if (raw != null) {
            try {
                val obj = org.json.JSONObject(raw)
                val user = obj.optString("user", "")
                val pass = obj.optString("pass", "")
                if (user.isNotEmpty() || pass.isNotEmpty()) {
                    call.resolve(JSObject().apply {
                        put("user", user)
                        put("pass", pass)
                    })
                    return
                }
            } catch (_: org.json.JSONException) {
            }
        }
        call.resolve(JSObject())
    }

    @PluginMethod
    fun saveWebDAVCredentials(call: com.getcapacitor.PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        val user = call.getString("user") ?: return call.reject("user is required")
        val pass = call.getString("pass") ?: return call.reject("pass is required")
        val key = "${KEY_WEBDAV_PREFIX}${url}"
        val json = org.json.JSONObject().apply {
            put("user", user)
            put("pass", pass)
        }.toString()
        writeSecurePreference(key, json)
        call.resolve()
    }

    // ── Foreground service lifecycle ──────────────────────────────────────

    @PluginMethod
    fun onAlarmFired(call: com.getcapacitor.PluginCall) {
        call.resolve()
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    private fun createAlarmIntent(
        context: Context,
        reminderId: String,
        todoId: String,
        todoTitle: String,
        triggerAt: Long
    ): Intent {
        return try {
            val cls = Class.forName(FULLSCREEN_CLASS)
            Intent(context, cls).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("reminderId", reminderId)
                putExtra("todoId", todoId)
                putExtra("todoTitle", todoTitle)
                putExtra("triggerAt", triggerAt)
                action = ALARM_ACTION
            }
        } catch (_: ClassNotFoundException) {
            Intent(ALARM_ACTION).apply {
                setPackage(context.packageName)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("reminderId", reminderId)
                putExtra("todoId", todoId)
                putExtra("todoTitle", todoTitle)
                putExtra("triggerAt", triggerAt)
            }
        }
    }

    private fun toRequestCode(reminderId: String): Int {
        return (reminderId.hashCode() and Int.MAX_VALUE) % 10000 + REQUEST_CODE_BASE
    }

    private fun readSecurePreference(key: String): String? {
        val context = activity ?: return null
        val prefs = getEncryptedPrefs(context)
        return prefs.getString(key, null)
    }

    private fun writeSecurePreference(key: String, value: String) {
        val context = activity ?: return
        val prefs = getEncryptedPrefs(context)
        prefs.edit().putString(key, value).apply()
    }

    private fun getEncryptedPrefs(context: Context): android.content.SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        return EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
}