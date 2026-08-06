package org.openeuler.agentinsight.qoder;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.StartupActivity;
import org.jetbrains.annotations.NotNull;

public final class AgentInsightStartupActivity implements StartupActivity.DumbAware {
    @Override
    public void runActivity(@NotNull Project project) {
        JetBrainsMarkerService service = ApplicationManager.getApplication().getService(JetBrainsMarkerService.class);
        CollectorInstaller.installAsync(service);
    }
}
