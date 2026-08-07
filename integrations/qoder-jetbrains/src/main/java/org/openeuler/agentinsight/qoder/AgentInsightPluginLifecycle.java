package org.openeuler.agentinsight.qoder;

import com.intellij.ide.plugins.DynamicPluginListener;
import com.intellij.ide.plugins.IdeaPluginDescriptor;
import org.jetbrains.annotations.NotNull;

public final class AgentInsightPluginLifecycle implements DynamicPluginListener {
    private static final String PLUGIN_ID = "org.openeuler.agentinsight.qoder.jetbrains";

    @Override
    public void beforePluginUnload(@NotNull IdeaPluginDescriptor pluginDescriptor, boolean isUpdate) {
        if (PLUGIN_ID.equals(pluginDescriptor.getPluginId().getIdString())) {
            CollectorInstaller.flushOwnedCollector();
            CollectorInstaller.uninstallOwnedCollector();
        }
    }
}
