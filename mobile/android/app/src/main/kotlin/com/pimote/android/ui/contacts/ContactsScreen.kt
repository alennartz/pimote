package com.pimote.android.ui.contacts


import android.content.Context

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
import androidx.compose.runtime.LaunchedEffect
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
import com.pimote.android.app.pimoteContainer
import com.pimote.android.call.CallState
import com.pimote.android.net.WsState
import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.session.SessionProjectGroup
import com.pimote.android.session.buildSessionProjectGroups
import com.pimote.android.session.cwdLabelFor
import com.pimote.android.session.formatRelativeTime
import com.pimote.android.session.sessionDisplayName
import com.pimote.android.telephony.PhoneAccountRules
import com.pimote.android.shortcuts.CallByPimoteUri
import com.pimote.android.telephony.PIMOTE_URI_SCHEME
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

class ContactsViewModel(private val container: AppContainer) : ViewModel() {
    companion object {
        fun factory(container: AppContainer): androidx.lifecycle.ViewModelProvider.Factory =
            object : androidx.lifecycle.ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T = ContactsViewModel(container) as T
            }
    }

    val projects: StateFlow<List<ProjectMeta>> = container.sessionRepository.projects
    val sessions: StateFlow<List<SessionMeta>> = container.sessionRepository.sessions
    val wsState: StateFlow<WsState> = container.wsClient.state
    val callState: StateFlow<CallState> = container.callController.state

    suspend fun refresh(): Result<Unit> = runCatching {
        container.sessionRepository.refresh()
    }
}

/**
 * Pre-flattened row entries for the grouped contacts list. We materialize
 * project headers and their session children into a single linear list so
 * the LazyColumn can render with one [items] call and stable per-row keys
 * via [handleId]. Each row carries the index of the group it belongs to
 * so the renderer can decide whether to draw a top divider on the header
 * (omitted on the very first group).
 */
private sealed interface ContactsRow {
    val handleId: String
    val groupIndex: Int
    data class ProjectHeader(
        override val handleId: String,
        override val groupIndex: Int,
        val label: String,
    ) : ContactsRow
    data class SessionChild(
        override val handleId: String,
        override val groupIndex: Int,
        val title: String,
        val cwdLabel: String?,
        val metadataLine: String,
    ) : ContactsRow
}

private fun flattenGroups(
    groups: List<SessionProjectGroup>,
    labelByPath: Map<String, String>,
    nowMillis: Long,
): List<ContactsRow> {
    val out = ArrayList<ContactsRow>(groups.sumOf { 1 + it.sessions.size })
    groups.forEachIndexed { idx, g ->
        val projectLabel = labelByPath[g.project.folderPath] ?: g.project.folderName
        out += ContactsRow.ProjectHeader(
            handleId = PhoneAccountRules.projectHandleId(g.project.folderPath),
            groupIndex = idx,
            label = projectLabel,
        )
        for (s in g.sessions) {
            out += ContactsRow.SessionChild(
                handleId = PhoneAccountRules.sessionHandleId(s.sessionId),
                groupIndex = idx,
                title = sessionDisplayName(s),
                cwdLabel = cwdLabelFor(s, s.folderPath),
                metadataLine = sessionMetadataLine(s, nowMillis),
            )
        }
    }
    return out
}

private fun sessionMetadataLine(session: SessionMeta, nowMillis: Long): String {
    val msgs = "${session.messageCount} msg${if (session.messageCount != 1) "s" else ""}"
    val rel = formatRelativeTime(session.modified, nowMillis)
    return "$msgs · $rel"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactsScreen(viewModel: ContactsViewModel, onEditSettings: () -> Unit) {
    val projects by viewModel.projects.collectAsState()
    val sessions by viewModel.sessions.collectAsState()
    val wsState by viewModel.wsState.collectAsState()
    val callState by viewModel.callState.collectAsState()
    val context = LocalContextOrNull()
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var refreshing by remember { mutableStateOf(false) }
    var loadingHandleId by remember { mutableStateOf<String?>(null) }
    // Clear the per-row loading spinner when the call leaves Idle (the call is
    // in flight and InCallActivity is launching) or when it terminates. The
    // tap-time clear-immediately path produces no observable spinner because
    // both writes happen before recomposition; deriving the clear from the
    // controller's state gives the spinner a real lifetime.
    LaunchedEffect(callState) {
        if (callState !is CallState.Idle) {
            loadingHandleId = null
        }
    }

    // Recompute the row list only when projects/sessions change, not on every
    // recomposition. Mirror the PWA: group sessions under their parent project
    // by recency, drop empty projects. The relative-time strings are computed
    // at composition time from System.currentTimeMillis(); they don't auto-tick
    // (PWA parity).
    val rows = remember(projects, sessions) {
        val labelByPath = PhoneAccountRules.disambiguateFolderLabels(
            (projects.map { it.folderPath } + sessions.map { it.folderPath }).distinct(),
        )
        val groups = buildSessionProjectGroups(projects, sessions)
        flattenGroups(groups, labelByPath, System.currentTimeMillis())
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
                        val handleId = row.handleId
                        val onCall: () -> Unit = onCall@{
                            if (context == null) return@onCall
                            loadingHandleId = handleId
                            // Single source of truth for placing a pimote call lives
                            // in CallByPimoteUri.placeCall. Don't clear loadingHandleId
                            // on success — dispatch is async; LaunchedEffect(callState)
                            // above clears the spinner once the controller leaves Idle.
                            val dispatched = CallByPimoteUri.placeCall(
                                context = context,
                                pimoteUri = "$PIMOTE_URI_SCHEME:$handleId",
                                telecom = context.pimoteContainer.telecomFacade,
                            )
                            if (!dispatched) {
                                loadingHandleId = null
                                scope.launch {
                                    snackbar.showSnackbar("Couldn't place call")
                                }
                            }
                        }
                        when (row) {
                            is ContactsRow.ProjectHeader -> ProjectHeaderRow(
                                label = row.label,
                                isLoading = loadingHandleId == handleId,
                                showTopDivider = row.groupIndex > 0,
                                onCallProject = onCall,
                            )
                            is ContactsRow.SessionChild -> SessionListRow(
                                title = row.title,
                                cwdLabel = row.cwdLabel,
                                metadataLine = row.metadataLine,
                                isLoading = loadingHandleId == handleId,
                                onTap = onCall,
                            )
                        }
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
