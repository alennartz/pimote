package com.pimote.android.call

import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import androidx.annotation.RequiresApi
import com.pimote.android.util.L
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Owns the system communication-device selection for the lifetime of an
 * active call. This is the API 31+ replacement for
 * `AudioManager.startBluetoothSco()` + `isBluetoothScoOn`, and it is what
 * actually engages the BT HFP/SCO link when a Bluetooth headset or
 * Android Auto is connected.
 *
 * Why this exists (the bug it fixes): pimote uses a self-managed
 * [android.telecom.ConnectionService]. Per Android docs, self-managed
 * apps are responsible for their own call audio — Telecom does not
 * auto-route to BT for self-managed calls. Before this class was added,
 * nothing in the app ever requested SCO, so call audio (which the OS
 * places on `STREAM_VOICE_CALL` because the system is in
 * `MODE_IN_COMMUNICATION`) had no SCO link to flow over and no A2DP
 * fallback (A2DP is media-only). Result: both directions fell back to
 * the phone's earpiece/speaker + builtin mic even when AA was connected.
 *
 * The router runs only on API 31+. On older releases the deprecated
 * `startBluetoothSco` path is not implemented; the call falls back to
 * the pre-existing Telecom-driven behaviour (broken-for-AA, but that's
 * unchanged from before).
 *
 * Lifecycle: [start] when the call leaves Idle, [stop] when it Ends.
 * Re-entrant calls are no-ops. Safe to call from any thread.
 */
@RequiresApi(Build.VERSION_CODES.S)
class CallAudioRouter(
    private val audioManager: AudioManager,
) {
    private val _speakerphoneOn = MutableStateFlow(false)
    /** Whether the active communication device is the builtin loudspeaker. */
    val speakerphoneOn: StateFlow<Boolean> = _speakerphoneOn.asStateFlow()

    private val _preferredInputDevice = MutableStateFlow<AudioDeviceInfo?>(null)
    /**
     * The capture device that matches the currently selected communication
     * device. `setCommunicationDevice` routes *output* to the chosen device,
     * but the WebRTC `AudioRecord` does not follow that selection on its own —
     * it stays bound to whatever input it opened against. The ADM owner
     * (SpeechmuxPeerImpl) observes this flow and re-points capture via
     * `setPreferredInputDevice` so the mic follows the route: the BT SCO /
     * BLE earbud mic, the Android Auto car mic, or the builtin mic. Null means
     * "no opinion" — let the OS/WebRTC default stand.
     */
    val preferredInputDevice: StateFlow<AudioDeviceInfo?> = _preferredInputDevice.asStateFlow()

    private val executor: Executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "call-audio-router").apply { isDaemon = true }
    }

    @Volatile private var active = false
    @Volatile private var speakerphoneRequested = false

    private val commDeviceListener =
        AudioManager.OnCommunicationDeviceChangedListener { device ->
            val onSpeaker = device?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            _speakerphoneOn.value = onSpeaker
            // The OS-confirmed comm device is authoritative — this fires on the
            // mid-call A2DP->HFP/SCO flip and on Android Auto hand-offs. Keep
            // the capture device in lockstep so the mic follows.
            updatePreferredInput(device)
            L.i(
                "Audio",
                "comm device changed -> type=${device?.type} name=${device?.productName} " +
                    "speakerphoneOn=$onSpeaker",
            )
        }

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
            if (!active) return
            L.d("Audio", "audio devices added (n=${addedDevices?.size ?: 0}) — re-evaluating")
            applyBestDevice()
        }
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
            if (!active) return
            L.d("Audio", "audio devices removed (n=${removedDevices?.size ?: 0}) — re-evaluating")
            applyBestDevice()
        }
    }

    @Synchronized
    fun start() {
        if (active) return
        active = true
        speakerphoneRequested = false
        try {
            audioManager.addOnCommunicationDeviceChangedListener(executor, commDeviceListener)
        } catch (t: Throwable) {
            L.w("Audio", "addOnCommunicationDeviceChangedListener threw", t)
        }
        try {
            // null handler = post on the main looper; sufficient here since the
            // callbacks only re-trigger applyBestDevice() which is @Synchronized.
            audioManager.registerAudioDeviceCallback(deviceCallback, null)
        } catch (t: Throwable) {
            L.w("Audio", "registerAudioDeviceCallback threw", t)
        }
        applyBestDevice()
    }

    @Synchronized
    fun stop() {
        if (!active) return
        active = false
        speakerphoneRequested = false
        _speakerphoneOn.value = false
        _preferredInputDevice.value = null
        try { audioManager.removeOnCommunicationDeviceChangedListener(commDeviceListener) } catch (_: Throwable) {}
        try { audioManager.unregisterAudioDeviceCallback(deviceCallback) } catch (_: Throwable) {}
        try { audioManager.clearCommunicationDevice() } catch (t: Throwable) {
            L.w("Audio", "clearCommunicationDevice threw", t)
        }
    }

    /**
     * Request speakerphone on/off. While the router is active this forces the
     * comm device to/from the builtin loudspeaker. When inactive the request
     * is stashed and applied on the next [start].
     */
    @Synchronized
    fun setSpeakerphone(enabled: Boolean) {
        speakerphoneRequested = enabled
        if (active) applyBestDevice()
    }

    @Synchronized
    private fun applyBestDevice() {
        val available: List<AudioDeviceInfo> = try {
            audioManager.availableCommunicationDevices
        } catch (t: Throwable) {
            L.w("Audio", "availableCommunicationDevices threw", t)
            return
        }
        if (available.isEmpty()) {
            L.w("Audio", "no available communication devices")
            return
        }
        val target = pickBest(available, speakerphoneRequested) ?: return
        // Keep capture pointed at the input matching our chosen output device,
        // even when the comm device is already correct (early-return below).
        updatePreferredInput(target)
        val current = try { audioManager.communicationDevice } catch (_: Throwable) { null }
        if (current?.id == target.id) return
        val ok = try {
            audioManager.setCommunicationDevice(target)
        } catch (t: Throwable) {
            L.w("Audio", "setCommunicationDevice threw", t)
            false
        }
        L.i(
            "Audio",
            "setCommunicationDevice type=${target.type} name=${target.productName} " +
                "ok=$ok speakerReq=$speakerphoneRequested " +
                "available=${available.joinToString { it.type.toString() }}",
        )
    }

    /**
     * Resolve the capture device that matches [comm] and publish it on
     * [preferredInputDevice]. Side-effecting shell around the pure
     * [pickInputDevice]; enumerates the current input devices and stores the
     * match (or null when there is no sensible match — leave the default).
     */
    private fun updatePreferredInput(comm: AudioDeviceInfo?) {
        val inputs: List<AudioDeviceInfo> = try {
            audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList()
        } catch (t: Throwable) {
            L.w("Audio", "getDevices(INPUTS) threw", t)
            emptyList()
        }
        _preferredInputDevice.value = pickInputDevice(comm, inputs)
    }

    /**
     * Pick the best communication device given the available set.
     *
     * When the user has asked for speakerphone, builtin speaker wins. Otherwise
     * the priority order is: external headsets (BT SCO / BLE / wired / USB) >
     * builtin earpiece > builtin speaker as last resort. This is the policy
     * that gives "car audio when connected to a car / BT, phone otherwise"
     * with no user toggle required.
     */
    private fun pickBest(
        devices: List<AudioDeviceInfo>,
        speakerphone: Boolean,
    ): AudioDeviceInfo? {
        if (speakerphone) {
            return devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                ?: devices.firstOrNull()
        }
        val priority = intArrayOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_HEARING_AID,
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        )
        for (t in priority) {
            devices.firstOrNull { it.type == t }?.let { return it }
        }
        return devices.firstOrNull()
    }

    companion object {
        /**
         * Map the selected communication ([comm]) device to the capture device
         * the AudioRecord should bind to, given the available [inputs]
         * (`GET_DEVICES_INPUTS`). Pure: no Android calls, fully testable.
         *
         * `setCommunicationDevice` takes an output-oriented endpoint; for a
         * headset the matching mic is the same physical device, matched by
         * type and — for BT, where several may be present — by `address`.
         * Builtin earpiece/speaker output maps to the builtin mic. An unknown
         * or absent comm device yields null ("no opinion": leave the default),
         * which is safer than forcing a guess.
         */
        internal fun pickInputDevice(
            comm: AudioDeviceInfo?,
            inputs: List<AudioDeviceInfo>,
        ): AudioDeviceInfo? {
            if (comm == null) return null
            fun match(vararg types: Int): AudioDeviceInfo? {
                for (t in types) {
                    inputs.firstOrNull { it.type == t && it.address == comm.address }?.let { return it }
                }
                for (t in types) {
                    inputs.firstOrNull { it.type == t }?.let { return it }
                }
                return null
            }
            return when (comm.type) {
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> match(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
                AudioDeviceInfo.TYPE_BLE_HEADSET -> match(AudioDeviceInfo.TYPE_BLE_HEADSET)
                AudioDeviceInfo.TYPE_WIRED_HEADSET -> match(AudioDeviceInfo.TYPE_WIRED_HEADSET)
                AudioDeviceInfo.TYPE_USB_HEADSET ->
                    match(AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE)
                AudioDeviceInfo.TYPE_USB_DEVICE ->
                    match(AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET)
                AudioDeviceInfo.TYPE_HEARING_AID ->
                    match(AudioDeviceInfo.TYPE_HEARING_AID, AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
                AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
                AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
                ->
                    inputs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }
                else -> null
            }
        }
    }
}
