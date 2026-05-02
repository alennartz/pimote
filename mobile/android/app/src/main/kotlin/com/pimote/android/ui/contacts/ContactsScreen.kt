package com.pimote.android.ui.contacts

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import com.pimote.android.R
import com.pimote.android.app.AppContainer
import com.pimote.android.net.WsState
import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.telephony.PIMOTE_SERVICE_HANDLE_ID
import com.pimote.android.telephony.PIMOTE_URI_SCHEME
import com.pimote.android.telephony.PhoneAccountRules
import com.pimote.android.telephony.PimoteConnectionService
import com.pimote.android.ui.components.ContactKind
import com.pimote.android.ui.components.ContactRow
import com.pimote.android.ui.components.EmptyState
import com.pimote.android.ui.components.EmptyStateCta
import com.pimote.android.ui.components.PimoteSnackbarHost
import com.pimote.android.ui.components.PimoteSnackbarVariant
import com.pimote.android.ui.components.StatusPill
import com.pimote.android.ui.components.StatusPillState
import com.pimote.android.ui.components.cleanStatusReason
import com.pimote.android.ui.theme.PimoteTheme
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

private data class ContactRowData(val handleId: String, val label: String, val isProject: Boolean)

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
    var loadingHandleId by remember { mutableStateOf<String?>(null) }

    val labelByPath = PhoneAccountRules.disambiguateFolderLabels(
        (projects.map { it.folderPath } + sessions.map { it.folderPath }).distinct(),
    )
    val rows = buildList {
        projects.forEach { p ->
            val label = labelByPath[p.folderPath] ?: p.folderName
            add(ContactRowData(PhoneAccountRules.projectHandleId(p.folderPath), label, isProject = true))
        }
        sessions.forEach { s ->
            val prefix = labelByPath[s.folderPath] ?: s.folderName
            val name = s.name?.takeIf { it.isNotBlank() } ?: "untitled"
            add(ContactRowData(PhoneAccountRules.sessionHandleId(s.sessionId), "$prefix/$name", isProject = false))
        }
    }

    // Note: `handleId` here is the SOURCE_ID encoded into the URI on placeCall.
    // It identifies the target session/project; it's not a PhoneAccount handle.
    // (We have exactly one PhoneAccount; see DR-019.)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pimote") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = PimoteTheme.colors.surfacePlus,
                ),
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
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                color = PimoteTheme.colors.indigo,
                            )
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
        snackbarHost = {
            PimoteSnackbarHost(snackbar, variant = PimoteSnackbarVariant.Error)
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            StatusPill(
                state = when (val s = wsState) {
                    WsState.Disconnected -> StatusPillState.Disconnected
                    WsState.Connecting -> StatusPillState.Connecting
                    WsState.Connected -> StatusPillState.Connected
                    is WsState.Reconnecting -> StatusPillState.Reconnecting(s.attempt)
                    is WsState.Failed -> StatusPillState.Failed(s.reason)
                },
                modifier = Modifier.padding(
                    horizontal = PimoteTheme.spacing.ml,
                    vertical = PimoteTheme.spacing.s,
                ),
            )

            if (rows.isEmpty()) {
                ContactsEmptyState(wsState, onEditSettings)
            } else {
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(rows, key = { it.handleId }) { row ->
                        ContactRow(
                            title = row.label,
                            subtitle = if (row.isProject) {
                                "New session in this project"
                            } else {
                                "Tap to call this session"
                            },
                            kind = if (row.isProject) ContactKind.Project else ContactKind.Session,
                            isLoading = loadingHandleId == row.handleId,
                            onTap = {
                                if (context == null) return@ContactRow
                                loadingHandleId = row.handleId
                                try {
                                    placeCall(context, row.handleId)
                                    loadingHandleId = null
                                } catch (e: SecurityException) {
                                    loadingHandleId = null
                                    L.w("Contacts", "placeCall SecurityException", e)
                                    scope.launch {
                                        snackbar.showSnackbar("Permission missing for placeCall")
                                    }
                                } catch (e: Throwable) {
                                    loadingHandleId = null
                                    L.w("Contacts", "placeCall failed: ${e.message}", e)
                                    scope.launch {
                                        snackbar.showSnackbar("Failed: ${e.message}")
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ContactsEmptyState(state: WsState, onEditSettings: () -> Unit) {
    when (state) {
        WsState.Connected -> EmptyState(
            icon = painterResource(R.drawable.ic_dashboard_outlined),
            primary = "No sessions yet.",
            secondary = "Open a project in Pimote on the web — it will appear here as a contact.",
        )
        WsState.Connecting -> EmptyState(
            icon = painterResource(R.drawable.ic_sync),
            primary = "Connecting to Pimote.",
            secondary = "Your sessions will appear once the connection is established.",
            iconAnimating = true,
        )
        is WsState.Reconnecting -> EmptyState(
            icon = painterResource(R.drawable.ic_sync),
            primary = "Connecting to Pimote.",
            secondary = "Your sessions will appear once the connection is established.",
            iconAnimating = true,
        )
        is WsState.Failed -> EmptyState(
            icon = painterResource(R.drawable.ic_signal_wifi_bad),
            primary = "Couldn't connect.",
            secondary = cleanStatusReason(state.reason),
            cta = EmptyStateCta("Open Settings") { onEditSettings() },
        )
        WsState.Disconnected -> EmptyState(
            icon = painterResource(R.drawable.ic_wifi_off),
            primary = "Not connected.",
            secondary = "Configure a server URL in Settings.",
            cta = EmptyStateCta("Open Settings") { onEditSettings() },
        )
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
