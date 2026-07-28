package org.openeuler.agentinsight.qoder;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.StatusBar;
import com.intellij.openapi.wm.StatusBarWidget;
import com.intellij.openapi.wm.StatusBarWidgetFactory;
import org.jetbrains.annotations.NotNull;

public final class AgentInsightStatusBarWidgetFactory implements StatusBarWidgetFactory {
    public static final String ID = "AgentInsightQoder";

    @Override
    public @NotNull String getId() {
        return ID;
    }

    @Override
    public @NotNull String getDisplayName() {
        return "Agent Insight Qoder Collector";
    }

    @Override
    public boolean isAvailable(@NotNull Project project) {
        return !project.isDisposed();
    }

    @Override
    public @NotNull StatusBarWidget createWidget(@NotNull Project project) {
        return new AgentInsightStatusBarWidget(project);
    }

    @Override
    public void disposeWidget(@NotNull StatusBarWidget widget) {
        Disposer.dispose(widget);
    }

    @Override
    public boolean canBeEnabledOn(@NotNull StatusBar statusBar) {
        return true;
    }
}
