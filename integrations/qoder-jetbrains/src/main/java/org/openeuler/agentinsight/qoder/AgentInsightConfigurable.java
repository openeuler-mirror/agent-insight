/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.openeuler.agentinsight.qoder;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.options.Configurable;
import com.intellij.openapi.options.ConfigurationException;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBPasswordField;
import com.intellij.ui.components.JBTextField;
import com.intellij.util.ui.FormBuilder;
import org.jetbrains.annotations.Nls;
import org.jetbrains.annotations.Nullable;

import javax.swing.JComponent;
import javax.swing.JPanel;
import java.io.IOException;
import java.util.Map;

public final class AgentInsightConfigurable implements Configurable {
    private final JBTextField hostField = new JBTextField();
    private final JBPasswordField apiKeyField = new JBPasswordField();
    private JPanel panel;

    @Override
    public @Nls String getDisplayName() {
        return "Agent Insight";
    }

    @Override
    public @Nullable JComponent createComponent() {
        panel = FormBuilder.createFormBuilder()
                .addLabeledComponent(new JBLabel("Server URL:"), hostField, 1, false)
                .addLabeledComponent(new JBLabel("API Key:"), apiKeyField, 1, false)
                .addComponentToRightColumn(new JBLabel("Configuration is shared with Qoder CLI and Desktop."))
                .addComponentFillVertically(new JPanel(), 0)
                .getPanel();
        reset();
        return panel;
    }

    @Override
    public boolean isModified() {
        Map<String, String> config = CollectorInstaller.readConfig();
        return !hostField.getText().strip().equals(config.getOrDefault("AGENT_INSIGHT_HOST", ""))
                || !new String(apiKeyField.getPassword()).strip().equals(config.getOrDefault("AGENT_INSIGHT_API_KEY", ""));
    }

    @Override
    public void apply() throws ConfigurationException {
        String host = hostField.getText().strip();
        String apiKey = new String(apiKeyField.getPassword()).strip();
        if (!host.matches("https?://.+")) throw new ConfigurationException("Server URL must start with http:// or https://");
        if (apiKey.isBlank()) throw new ConfigurationException("API Key is required");
        if (host.contains("\n") || host.contains("\r") || apiKey.contains("\n") || apiKey.contains("\r")) {
            throw new ConfigurationException("Configuration values cannot contain newlines");
        }
        try {
            CollectorInstaller.writeConnectionConfig(host, apiKey);
        } catch (IOException error) {
            throw new ConfigurationException("Unable to write Agent Insight configuration: " + error.getMessage());
        }
        JetBrainsMarkerService service = ApplicationManager.getApplication().getService(JetBrainsMarkerService.class);
        CollectorInstaller.installAsync(service);
    }

    @Override
    public void reset() {
        Map<String, String> config = CollectorInstaller.readConfig();
        hostField.setText(config.getOrDefault("AGENT_INSIGHT_HOST", "http://localhost:3000"));
        apiKeyField.setText(config.getOrDefault("AGENT_INSIGHT_API_KEY", ""));
    }

    @Override
    public void disposeUIResources() {
        panel = null;
        apiKeyField.setText("");
    }
}
