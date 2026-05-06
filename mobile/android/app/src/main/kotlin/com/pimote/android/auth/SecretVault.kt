package com.pimote.android.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Hardware-backed (where available) symmetric encryption for app secrets.
 *
 * The AES-256/GCM key lives in the AndroidKeyStore under [ALIAS]. On modern
 * devices the key material is held in the TEE (or StrongBox) and never
 * surfaces in app memory — we only get a [SecretKey] handle that the
 * AndroidKeyStore JCA provider routes back into secure hardware.
 *
 * [seal] returns `iv || ciphertext` (12-byte GCM IV prefix). [open]
 * reverses it. Persist the bytes (typically base64) wherever convenient;
 * recovery is impossible without this device's keystore key.
 *
 * Used by [com.pimote.android.settings.SettingsImpl] to store the
 * Cloudflare Access service-token secret. Other secrets can reuse the same
 * vault; the alias is shared because GCM with a fresh IV per call is safe
 * for unrelated plaintexts under the same key.
 */
object SecretVault {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "pimote.secretvault.v1"
    private const val GCM_TAG_BITS = 128
    private const val GCM_IV_BYTES = 12

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        kg.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return kg.generateKey()
    }

    /** Encrypt [plaintext] under the vault key. Returns `iv || ciphertext`. */
    fun seal(plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key())
        }
        val iv = cipher.iv
        check(iv.size == GCM_IV_BYTES) { "expected 12-byte GCM IV, got ${iv.size}" }
        val ct = cipher.doFinal(plaintext)
        return iv + ct
    }

    /**
     * Decrypt a blob produced by [seal]. Throws [javax.crypto.AEADBadTagException]
     * (or related) if the blob was tampered with or the keystore key was
     * regenerated since [seal] was called.
     */
    fun open(blob: ByteArray): ByteArray {
        require(blob.size > GCM_IV_BYTES) { "sealed blob too short: ${blob.size}" }
        val iv = blob.copyOfRange(0, GCM_IV_BYTES)
        val ct = blob.copyOfRange(GCM_IV_BYTES, blob.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, iv))
        }
        return cipher.doFinal(ct)
    }
}
