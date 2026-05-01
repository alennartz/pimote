package com.pimote.android.ui.contacts

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pimote.android.app.AppContainer
import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.telephony.PhoneAccountRules
import com.pimote.android.telephony.PimoteConnectionService
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class ContactsViewModel : ViewModel() {
    private val container = AppContainer.instance
    val projects: StateFlow<List<ProjectMeta>> = container.sessionRepository.projects
    val sessions: StateFlow<List<SessionMeta>> = container.sessionRepository.sessions

    fun refresh() {
        viewModelScope.launch { runCatching { container.sessionRepository.refresh() } }
    }
}

private data class ContactRow(val handleId: String, val label: String, val isProject: Boolean)

@Composable
fun ContactsScreen(viewModel: ContactsViewModel) {
    val projects by viewModel.projects.collectAsState()
    val sessions by viewModel.sessions.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // Disambiguate over the union of project + session folder paths to match the registrar's
    // input set (PhoneAccountRules.computeDesiredAccounts). Disambiguating projects-only would
    // let a session whose folder isn't in the current projects snapshot render with a
    // different prefix than what Telecom registered the account under.
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

    Scaffold { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            Button(onClick = { viewModel.refresh() }) { Text("Refresh") }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            LazyColumn(modifier = Modifier.fillMaxWidth()) {
                items(rows, key = { it.handleId }) { row ->
                    Text(
                        text = (if (row.isProject) "📁 " else "🗨 ") + row.label,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { placeCall(context, row.handleId) }
                            .padding(vertical = 12.dp),
                    )
                }
            }
        }
    }
}

private fun placeCall(context: Context, handleId: String) {
    val tm = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
    val component = ComponentName(context.applicationContext, PimoteConnectionService::class.java)
    val handle = PhoneAccountHandle(component, handleId)
    val uri = Uri.fromParts("pimote", handleId, null)
    val extras = Bundle().apply {
        putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
    }
    try {
        tm.placeCall(uri, extras)
    } catch (_: SecurityException) {
        // Permission missing — surface in a future iteration via UI snackbar.
    }
}
