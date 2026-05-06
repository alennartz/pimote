package com.pimote.android.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.pimote.android.ui.theme.PimoteTheme

@Composable
fun PimoteOutlinedTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isError: Boolean = false,
    errorMessage: String? = null,
    singleLine: Boolean = true,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
) {
    val colors = PimoteTheme.colors
    Column(modifier = modifier) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            enabled = enabled,
            isError = isError,
            singleLine = singleLine,
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            shape = RoundedCornerShape(12.dp),
            textStyle = PimoteTheme.typography.bodyLarge,
            label = { Text(label) },
            placeholder = { Text(placeholder, color = colors.inkDisabled) },
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = colors.indigo,
                unfocusedBorderColor = colors.line,
                errorBorderColor = colors.danger,
                focusedLabelColor = colors.indigo,
                unfocusedLabelColor = colors.inkSecondary,
                errorLabelColor = colors.danger,
                cursorColor = colors.indigo,
                focusedTextColor = colors.ink,
                unfocusedTextColor = colors.ink,
                disabledTextColor = colors.inkDisabled,
                unfocusedContainerColor = colors.surfacePlus,
                focusedContainerColor = colors.surfacePlus,
                errorContainerColor = colors.surfacePlus,
                disabledContainerColor = colors.surfacePlus,
            ),
        )
        if (isError && errorMessage != null) {
            Text(
                text = errorMessage,
                style = PimoteTheme.typography.bodySmall,
                color = colors.danger,
                modifier = Modifier.padding(start = 16.dp, top = 4.dp),
            )
        }
    }
}

@Preview
@Composable
private fun PimoteOutlinedTextFieldPreviewDefault() {
    PimoteTheme {
        PimoteOutlinedTextField(
            value = "",
            onValueChange = {},
            label = "Pimote server URL",
            placeholder = "https://pimote.example.com",
        )
    }
}

@Preview
@Composable
private fun PimoteOutlinedTextFieldPreviewFilled() {
    PimoteTheme {
        PimoteOutlinedTextField(
            value = "https://pimote.example.com",
            onValueChange = {},
            label = "Pimote server URL",
            placeholder = "https://pimote.example.com",
        )
    }
}

@Preview
@Composable
private fun PimoteOutlinedTextFieldPreviewError() {
    PimoteTheme {
        PimoteOutlinedTextField(
            value = "bad",
            onValueChange = {},
            label = "Pimote server URL",
            placeholder = "https://pimote.example.com",
            isError = true,
            errorMessage = "Connect failed: invalid URL",
        )
    }
}

@Preview
@Composable
private fun PimoteOutlinedTextFieldPreviewDisabled() {
    PimoteTheme {
        PimoteOutlinedTextField(
            value = "https://pimote.example.com",
            onValueChange = {},
            label = "Pimote server URL",
            placeholder = "https://pimote.example.com",
            enabled = false,
        )
    }
}
