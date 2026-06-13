package com.pimote.android.car

import android.content.Intent
import androidx.car.app.Screen
import androidx.car.app.Session

/**
 * Root car session. Returns [ProjectListScreen] as the head-unit root screen.
 */
class PimoteCarSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen = ProjectListScreen(carContext)
}
