package org.openeuler.agentinsight.qoder;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.application.PathManager;
import org.jetbrains.annotations.NotNull;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import static com.intellij.util.concurrency.AppExecutorUtil.getAppScheduledExecutorService;

public final class JetBrainsMarkerService implements Disposable {
    private static final Logger LOG = Logger.getInstance(JetBrainsMarkerService.class);
    private final long pid = ProcessHandle.current().pid();
    private final Path markerPath = CollectorInstaller.insightDirectory()
            .resolve("qoder-jetbrains")
            .resolve("ide-processes")
            .resolve(pid + ".json");
    private final ScheduledFuture<?> heartbeat;
    private volatile String collectorStatus = "Starting";

    public JetBrainsMarkerService() {
        writeMarker();
        heartbeat = getAppScheduledExecutorService().scheduleWithFixedDelay(this::writeMarker, 30, 30, TimeUnit.SECONDS);
    }

    public @NotNull String getCollectorStatus() {
        return collectorStatus;
    }

    public void setCollectorStatus(@NotNull String value) {
        collectorStatus = value;
        writeMarker();
    }

    public boolean isReady() {
        return collectorStatus.startsWith("Active");
    }

    private void writeMarker() {
        try {
            Files.createDirectories(markerPath.getParent());
            ApplicationInfo info = ApplicationInfo.getInstance();
            String json = "{\n"
                    + "  \"pid\": " + pid + ",\n"
                    + "  \"updatedAt\": \"" + Instant.now() + "\",\n"
                    + "  \"ideName\": \"" + escape(info.getFullApplicationName()) + "\",\n"
                    + "  \"ideVersion\": \"" + escape(info.getFullVersion()) + "\",\n"
                    + "  \"ideLogPath\": \"" + escape(PathManager.getLogPath()) + "\",\n"
                    + "  \"status\": \"" + escape(collectorStatus) + "\"\n"
                    + "}\n";
            Path temporary = markerPath.resolveSibling(markerPath.getFileName() + ".tmp");
            Files.writeString(temporary, json, StandardCharsets.UTF_8);
            try {
                Files.move(temporary, markerPath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException ignored) {
                Files.move(temporary, markerPath, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (Exception error) {
            LOG.warn("Unable to update the Agent Insight JetBrains process marker", error);
        }
    }

    private static String escape(String value) {
        return String.valueOf(value)
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n");
    }

    @Override
    public void dispose() {
        CollectorInstaller.flushOwnedCollector();
        heartbeat.cancel(false);
        try {
            Files.deleteIfExists(markerPath);
            Path processDirectory = markerPath.getParent();
            Files.deleteIfExists(processDirectory);
            Files.deleteIfExists(processDirectory.getParent());
        } catch (IOException error) {
            // Another JetBrains IDE instance or the runtime directory may still own the parent.
            // In that case only this process marker must be removed.
            LOG.debug("Unable to remove an Agent Insight JetBrains marker directory", error);
        }
    }
}
