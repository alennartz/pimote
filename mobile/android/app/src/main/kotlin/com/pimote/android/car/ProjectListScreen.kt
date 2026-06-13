package com.pimote.android.car

import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.lifecycle.lifecycleScope
import com.pimote.android.app.pimoteContainer
import com.pimote.android.net.WsState
import com.pimote.android.shortcuts.CallByPimoteUri
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Root car screen: one tappable row per project. Tapping places the project
 * hotline (new-session) call. A header "Sessions" action pushes
 * [ResumeSessionsScreen].
 *
 * Thin shell over [CarRowModels] and the existing call machinery. Reactivity
 * is driven by collecting the repository flows on this screen's own lifecycle
 * scope and calling [invalidate] on each emission — the collector captures the
 * final `this` reference, never a reassignable slot.
 */
class ProjectListScreen(carContext: CarContext) : Screen(carContext) {

    init {
        observeRepositoryAndInvalidate()
    }

    private fun observeRepositoryAndInvalidate() {
        val container = carContext.pimoteContainer
        lifecycleScope.launch {
            combine(
                container.sessionRepository.projects,
                container.sessionRepository.sessions,
            ) { _, _ -> Unit }.collect { invalidate() }
        }
    }

    override fun onGetTemplate(): Template {
        val container = carContext.pimoteContainer
        val projects = container.sessionRepository.projects.value
        val sessions = container.sessionRepository.sessions.value
        val originConfigured = !container.settings.current.value?.pimoteOrigin.isNullOrBlank()
        val connected = container.wsClient.state.value is WsState.Connected

        val message = CarRowModels.carListMessage(
            originConfigured = originConfigured,
            connected = connected,
            hasProjects = projects.isNotEmpty(),
        )
        if (message != null) {
            return MessageTemplate.Builder(message)
                .setTitle("Pimote")
                .setHeaderAction(Action.APP_ICON)
                .build()
        }

        val limit = carContext.getCarService(ConstraintManager::class.java)
            .getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
        val rows = CarRowModels.projectCallRows(
            projects = projects,
            sessions = sessions,
            nowMillis = System.currentTimeMillis(),
            limit = limit,
        )
        val itemList = ItemList.Builder().apply {
            rows.forEach { row -> addItem(buildCarRow(carContext, row)) }
        }.build()

        return ListTemplate.Builder()
            .setSingleList(itemList)
            .setTitle("Pimote")
            .setHeaderAction(Action.APP_ICON)
            .setActionStrip(
                ActionStrip.Builder()
                    .addAction(
                        Action.Builder()
                            .setTitle("Sessions")
                            .setOnClickListener { screenManager.push(ResumeSessionsScreen(carContext)) }
                            .build(),
                    )
                    .build(),
            )
            .build()
    }
}

/**
 * Shared `CarRow` → tappable car `Row` builder for the car screens. Single home
 * for "turn a row model into a tappable row" so both screens stay in lockstep.
 */
internal fun buildCarRow(carContext: CarContext, row: CarRow): Row =
    Row.Builder()
        .setTitle(row.title)
        .addText(row.subtitle)
        .setOnClickListener { placeCarCall(carContext, row.dialUri) }
        .build()

/**
 * Shared row-tap dispatch for the car screens: place the call via the existing
 * machinery and show a transient toast reflecting the dispatch outcome.
 * Mirrors `ContactsScreen`, which gates on the same `placeCall` boolean.
 * Android Auto's own in-call UI takes over on success.
 */
internal fun placeCarCall(carContext: CarContext, dialUri: String) {
    val dispatched =
        CallByPimoteUri.placeCall(carContext, dialUri, carContext.pimoteContainer.telecomFacade)
    val message = if (dispatched) "Calling\u2026" else "Couldn't place call"
    CarToast.makeText(carContext, message, CarToast.LENGTH_SHORT).show()
}
