package com.pimote.android.ui.contacts

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pimote.android.app.AppContainer
import com.pimote.android.net.WsState
import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.telephony.PIMOTE_SERVICE_HANDLE_ID
import com.pimote.android.telephony.PIMOTE_URI_SCHEME
import com.pimote.android.telephony.PhoneAccountRules
import com.pimote.android.telephony.PimoteConnectionService
import com.pimote.android.util.L
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class ContactsViewModel : ViewModel() {
    private val container = AppContainer.instance
    val projects: StateFlow<List<ProjectMeta>> = container.sessionRepository.projects
    val sessions: StateFlow<List<SessionMeta>> = container.sessionRepository.sessions
    val wsState: StateFlow<WsState> = container.wsClient.state

    suspend fun refresh(): Result<Unit> = runCatching {
        container.sessionRepository.refresh()
    }
}

private data class ContactRow(val handleId: String, val label: String, val isProject: Boolean)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactsScreen(viewModel: ContactsViewModel, onEditSettings: () -> Unit) {
    val projects by viewModel.projects.collectAsState()
    val sessions by viewModel.sessions.collectAsState()
    val wsState by viewModel.wsState.collectAsState()
    val context = LocalContextOrNull()
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var refreshing by remember { mutableStateOf(false) }

    val labelByPath = PhoneAccountRules.disambiguateFolderLabels(
        (projects.map { it.folderPath } + sessions.map { it.folderPath }).distinct(),
    )
    val rows = buildList {
        projects.forEach { p ->
            val label = labelByPath[p.folderPath] ?: p.folderName
            add(ContactRow(PhoneAccountRules.projectHandleId(p.folderPath), label, isProject = true))
        }
        sessions.forEach { s ->
            val prefix = labelByPath[s.folderPath] ?: s.folderName
            val name = s.name?.takeIf { it.isNotBlank() } ?: "untitled"
            add(ContactRow(PhoneAccountRules.sessionHandleId(s.sessionId), "$prefix/$name", isProject = false))
        }
    }

    // Note: `handleId` here is the SOURCE_ID encoded into the URI on placeCall.
    // It identifies the target session/project; it's not a PhoneAccount handle.
    // (We have exactly one PhoneAccount; see DR-019.)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pimote") },
                actions = {
                    IconButton(
                        onClick = {
                            if (refreshing || context == null) return@IconButton
                            refreshing = true
                            scope.launch {
                                val r = viewModel.refresh()
                                refreshing = false
                                if (r.isFailure) {
                                    val msg = r.exceptionOrNull()?.message ?: "unknown error"
                                    L.w("Contacts", "refresh failed: $msg")
                                    snackbar.showSnackbar("Refresh failed: $msg")
                                }
                            }
                        },
                        enabled = !refreshing,
                    ) {
                        if (refreshing) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp))
                        } else {
                            Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                        }
                    }
                    IconButton(onClick = onEditSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            ConnectionBanner(wsState)
            HorizontalDivider()

            if (rows.isEmpty()) {
                EmptyState(wsState)
            } else {
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(rows, key = { it.handleId }) { row ->
                        ContactRow(row, onTap = { id ->
                            if (context == null) return@ContactRow
                            try {
                                placeCall(context, id)
                            } catch (e: SecurityException) {
                                L.w("Contacts", "placeCall SecurityException", e)
                                scope.launch { snackbar.showSnackbar("Permission missing for placeCall") }
                            } catch (e: Throwable) {
                                L.w("Contacts", "placeCall failed: ${e.message}", e)
                                scope.launch { snackbar.showSnackbar("Failed: ${e.message}") }
                            }
                        })
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectionBanner(state: WsState) {
    val (text, color) = when (state) {
        WsState.Disconnected -> "Disconnected" to Color(0xFF888888)
        WsState.Connecting -> "Connecting…" to Color(0xFFE0A800)
        WsState.Connected -> "Connected" to Color(0xFF2E7D32)
        is WsState.Reconnecting -> "Reconnecting (attempt ${state.attempt})" to Color(0xFFE0A800)
        is WsState.Failed -> "Failed: ${state.reason}" to Color(0xFFB00020)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .background(color = color, shape = CircleShape),
        )
        Text(text, fontFamily = FontFamily.Monospace, color = color)
    }
}

@Composable
private fun EmptyState(state: WsState) {
    val msg = when (state) {
        WsState.Connected -> "No sessions yet. Open a project in pimote — it'll appear here as a contact."
        WsState.Connecting,
        is WsState.Reconnecting -> "Connecting to pimote — your sessions will appear once we're connected."
        is WsState.Failed -> "Couldn't connect: ${state.reason}\nCheck the URL in Settings, or your VPN/Tailscale link."
        WsState.Disconnected -> "Not connected. Tap Settings to configure the pimote URL."
    }
    Box(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(msg, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ContactRow(row: ContactRow, onTap: (String) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onTap(row.handleId) }
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(if (row.isProject) "📁" else "🗨")
        Column {
            Text(row.label, style = MaterialTheme.typography.bodyLarge)
            Text(
                if (row.isProject) "Tap to start a new session" else "Tap to call this session",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun LocalContextOrNull(): Context? = androidx.compose.ui.platform.LocalContext.current

private fun placeCall(context: Context, sourceId: String) {
    val tm = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
    val component = ComponentName(context.applicationContext, PimoteConnectionService::class.java)
    // The single Pimote service PhoneAccount handles all `pimote:` URIs.
    val handle = PhoneAccountHandle(component, PIMOTE_SERVICE_HANDLE_ID)
    val uri = Uri.fromParts(PIMOTE_URI_SCHEME, sourceId, null)
    val extras = Bundle().apply {
        putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
    }
    L.i("Contacts", "placeCall sourceId=$sourceId uri=$uri")
    tm.placeCall(uri, extras)
}
