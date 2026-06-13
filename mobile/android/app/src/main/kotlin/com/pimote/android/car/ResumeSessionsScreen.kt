package com.pimote.android.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.lifecycle.lifecycleScope
import com.pimote.android.app.pimoteContainer
import kotlinx.coroutines.launch

/**
 * Resume screen: flat, recency-sorted list of all unarchived sessions. Tapping
 * resumes that session. Thin shell over [CarRowModels.resumeSessionRows] and
 * the existing call machinery.
 */
class ResumeSessionsScreen(carContext: CarContext) : Screen(carContext) {

    init {
        observeSessionsAndInvalidate()
    }

    private fun observeSessionsAndInvalidate() {
        val container = carContext.pimoteContainer
        lifecycleScope.launch {
            container.sessionRepository.sessions.collect { invalidate() }
        }
    }

    override fun onGetTemplate(): Template {
        val container = carContext.pimoteContainer
        val sessions = container.sessionRepository.sessions.value
        val limit = carContext.getCarService(ConstraintManager::class.java)
            .getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
        val rows = CarRowModels.resumeSessionRows(
            sessions = sessions,
            nowMillis = System.currentTimeMillis(),
            limit = limit,
        )
        val itemList = ItemList.Builder().apply {
            rows.forEach { row -> addItem(buildRow(row)) }
        }.build()

        return ListTemplate.Builder()
            .setSingleList(itemList)
            .setTitle("Resume session")
            .setHeaderAction(Action.BACK)
            .build()
    }

    private fun buildRow(row: CarRow): Row =
        Row.Builder()
            .setTitle(row.title)
            .addText(row.subtitle)
            .setOnClickListener { placeCarCall(carContext, row.dialUri) }
            .build()
}
