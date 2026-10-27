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
import com.intellij.openapi.options.ShowSettingsUtil;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.CustomStatusBarWidget;
import com.intellij.openapi.wm.StatusBar;
import com.intellij.ui.components.JBLabel;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.NotNull;

import javax.swing.JComponent;
import javax.swing.Timer;

public final class AgentInsightStatusBarWidget implements CustomStatusBarWidget {
    private final Project project;
    private final JBLabel label = new JBLabel();
    private final Timer timer;

    public AgentInsightStatusBarWidget(Project project) {
        this.project = project;
        label.setBorder(JBUI.Borders.empty(0, 6));
        label.setToolTipText("Open Agent Insight Qoder collector settings");
        label.addMouseListener(new java.awt.event.MouseAdapter() {
            @Override
            public void mouseClicked(java.awt.event.MouseEvent event) {
                ShowSettingsUtil.getInstance().showSettingsDialog(project, "Agent Insight");
            }
        });
        refresh();
        timer = new Timer(2_000, event -> refresh());
        timer.start();
    }

    private void refresh() {
        JetBrainsMarkerService service = ApplicationManager.getApplication().getService(JetBrainsMarkerService.class);
        label.setText(service.isReady() ? "Agent Insight ✓" : "Agent Insight !");
        label.setToolTipText(service.getCollectorStatus());
    }

    @Override
    public @NotNull String ID() {
        return AgentInsightStatusBarWidgetFactory.ID;
    }

    @Override
    public @NotNull JComponent getComponent() {
        return label;
    }

    @Override
    public void install(@NotNull StatusBar statusBar) {}

    @Override
    public void dispose() {
        timer.stop();
    }
}
