package com.pimote.android.call

import android.media.AudioDeviceInfo
import io.mockk.every
import io.mockk.mockk
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test

/**
 * Pure mapping from the selected communication (output) device to the capture
 * device the AudioRecord must bind to. This is what makes the mic follow the
 * comm-device route (BT SCO earbud mic, Android Auto, builtin) instead of
 * being stranded on whatever input it opened against.
 */
class PickInputDeviceTest {

    private fun device(type: Int, address: String = ""): AudioDeviceInfo =
        mockk<AudioDeviceInfo>().also {
            every { it.type } returns type
            every { it.address } returns address
        }

    @Test
    fun `null comm device yields no opinion`() {
        assertNull(CallAudioRouter.pickInputDevice(null, listOf(device(AudioDeviceInfo.TYPE_BUILTIN_MIC))))
    }

    @Test
    fun `bt sco output maps to bt sco mic`() {
        val scoMic = device(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
        val inputs = listOf(device(AudioDeviceInfo.TYPE_BUILTIN_MIC), scoMic)
        val out = CallAudioRouter.pickInputDevice(device(AudioDeviceInfo.TYPE_BLUETOOTH_SCO), inputs)
        assertSame(scoMic, out)
    }

    @Test
    fun `bt sco prefers the input with the matching address`() {
        val other = device(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, address = "AA:BB")
        val mine = device(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, address = "CC:DD")
        val inputs = listOf(other, mine)
        val out = CallAudioRouter.pickInputDevice(
            device(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, address = "CC:DD"),
            inputs,
        )
        assertSame(mine, out)
    }

    @Test
    fun `ble headset output maps to ble headset mic`() {
        val bleMic = device(AudioDeviceInfo.TYPE_BLE_HEADSET)
        val out = CallAudioRouter.pickInputDevice(
            device(AudioDeviceInfo.TYPE_BLE_HEADSET),
            listOf(device(AudioDeviceInfo.TYPE_BUILTIN_MIC), bleMic),
        )
        assertSame(bleMic, out)
    }

    @Test
    fun `wired headset output maps to wired headset mic`() {
        val wiredMic = device(AudioDeviceInfo.TYPE_WIRED_HEADSET)
        val out = CallAudioRouter.pickInputDevice(
            device(AudioDeviceInfo.TYPE_WIRED_HEADSET),
            listOf(wiredMic, device(AudioDeviceInfo.TYPE_BUILTIN_MIC)),
        )
        assertSame(wiredMic, out)
    }

    @Test
    fun `usb headset falls back to usb device input`() {
        val usbDev = device(AudioDeviceInfo.TYPE_USB_DEVICE)
        val out = CallAudioRouter.pickInputDevice(
            device(AudioDeviceInfo.TYPE_USB_HEADSET),
            listOf(device(AudioDeviceInfo.TYPE_BUILTIN_MIC), usbDev),
        )
        assertSame(usbDev, out)
    }

    @Test
    fun `builtin earpiece output maps to builtin mic`() {
        val mic = device(AudioDeviceInfo.TYPE_BUILTIN_MIC)
        val out = CallAudioRouter.pickInputDevice(
            device(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE),
            listOf(mic, device(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)),
        )
        assertSame(mic, out)
    }

    @Test
    fun `builtin speaker output maps to builtin mic`() {
        val mic = device(AudioDeviceInfo.TYPE_BUILTIN_MIC)
        val out = CallAudioRouter.pickInputDevice(
            device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER),
            listOf(mic),
        )
        assertSame(mic, out)
    }

    @Test
    fun `no matching input yields no opinion rather than a wrong guess`() {
        // BT SCO selected but only the builtin mic is enumerated — don't force it.
        val out = CallAudioRouter.pickInputDevice(
            device(AudioDeviceInfo.TYPE_BLUETOOTH_SCO),
            listOf(device(AudioDeviceInfo.TYPE_BUILTIN_MIC)),
        )
        assertNull(out)
    }
}
