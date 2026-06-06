package com.pimote.android.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import com.pimote.android.app.pimoteContainer
import com.pimote.android.ui.call.InCallActivity
import com.pimote.android.util.L
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Foreground service (type `phoneCall`) that owns the persistent, ongoing
 * call notification while a Pimote voice call is in progress. It gives the user
 * a place to hang up from the notification shade / lockscreen and to jump back
 * into the in-call screen, even when the app UI isn't foregrounded.
 *
 * Lifecycle:
 * - [com.pimote.android.app.AppContainer] starts it (`ACTION_START`) on the
 *   edge where the call leaves [CallState.Idle].
 * - The service collects [CallController.state] itself and calls `stopSelf`
 *   once the call reaches [CallState.Ended] or [CallState.Idle], so it always
 *   tears itself down even if the start edge is the only thing AppContainer
 *   drives.
 * - The notification's hang-up action posts `ACTION_HANGUP` back to the
 *   service, which forwards to [CallController.endCurrentCall].
 *
 * Uses [NotificationCompat.CallStyle] so the system renders it as a
 * high-priority, non-dismissible call notification (colorized, lockscreen
 * visible) — the sanctioned path on Android 14+ for ongoing-call notifications.
 */
class CallForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var collecting = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_HANGUP -> {
                L.i("Call", "notification hang-up")
                runCatching { pimoteContainer.callController.endCurrentCall() }
                return START_NOT_STICKY
            }
            ACTION_STOP -> {
                stopForegroundAndSelf()
                return START_NOT_STICKY
            }
            else -> {
                // ACTION_START (or a restart). Must post a foreground
                // notification synchronously to satisfy the 5s window.
                startForegroundNow()
                startCollecting()
                return START_NOT_STICKY
            }
        }
    }

    private fun startForegroundNow() {
        ensureChannel()
        val controller = runCatching { pimoteContainer.callController }.getOrNull()
        val notification = buildNotification(
            statusText = callNotificationStatusText(controller?.state?.value ?: CallState.Idle),
            displayName = "Pimote",
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun startCollecting() {
        if (collecting) return
        collecting = true
        val container = runCatching { pimoteContainer }.getOrNull() ?: run {
            stopForegroundAndSelf()
            return
        }
        scope.launch {
            combine(
                container.callController.state,
                container.sessionRepository.sessions,
            ) { state, sessions ->
                state to sessions
            }.collect { (state, sessions) ->
                if (state is CallState.Idle || state is CallState.Ended) {
                    stopForegroundAndSelf()
                    return@collect
                }
                val name = sessionIdOf(state)
                    ?.let { id -> sessions.firstOrNull { it.sessionId == id }?.name }
                    ?.takeIf { it.isNotBlank() }
                    ?: "Pimote"
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.notify(
                    NOTIFICATION_ID,
                    buildNotification(callNotificationStatusText(state), name),
                )
            }
        }
    }

    private fun buildNotification(statusText: String, displayName: String): Notification {
        val caller = Person.Builder().setName(displayName).setImportant(true).build()

        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, InCallActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val hangUpIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, CallForegroundService::class.java).setAction(ACTION_HANGUP),
            PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(com.pimote.android.R.drawable.ic_call_end)
            .setContentTitle(displayName)
            .setContentText(statusText)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, hangUpIntent))
            .build()
    }

    private fun stopForegroundAndSelf() {
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Ongoing calls",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Shows the active Pimote voice call so you can hang up."
            setShowBadge(false)
            setSound(null, null)
        }
        nm.createNotificationChannel(channel)
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "pimote_calls"
        private const val NOTIFICATION_ID = 0xCA11

        const val ACTION_START = "com.pimote.android.call.action.START"
        const val ACTION_STOP = "com.pimote.android.call.action.STOP"
        const val ACTION_HANGUP = "com.pimote.android.call.action.HANGUP"

        fun start(context: Context) {
            val intent = Intent(context, CallForegroundService::class.java)
                .setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, CallForegroundService::class.java).setAction(ACTION_STOP),
            )
        }

        private fun sessionIdOf(state: CallState): String? = when (state) {
            is CallState.Binding -> state.sessionId
            is CallState.Negotiating -> state.sessionId
            is CallState.Active -> state.sessionId
            is CallState.Ended -> state.sessionId
            is CallState.Dialing, CallState.Idle -> null
        }
    }
}

/**
 * Pure helper: the one-line status shown under the caller name in the call
 * notification. Factored out so it can be unit-tested without the framework.
 */
fun callNotificationStatusText(state: CallState): String = when (state) {
    is CallState.Dialing -> "Calling…"
    is CallState.Binding -> "Connecting…"
    is CallState.Negotiating -> "Connecting…"
    is CallState.Active -> "Voice call"
    is CallState.Ended -> "Call ended"
    CallState.Idle -> "Voice call"
}
