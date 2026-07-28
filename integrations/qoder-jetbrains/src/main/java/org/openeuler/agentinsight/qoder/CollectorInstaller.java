package org.openeuler.agentinsight.qoder;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.NotNull;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class CollectorInstaller {
    private static final Logger LOG = Logger.getInstance(CollectorInstaller.class);
    private static final AtomicBoolean INSTALLING = new AtomicBoolean();
    private static final AtomicBoolean FLUSHED = new AtomicBoolean();
    private static final List<String> RUNTIME_FILES = List.of(
            "qoder_trace_collector.mjs",
            "qoder_uploader_client.mjs",
            "qoder_setup.mjs",
            "qoder_jetbrains_uninstall.mjs"
    );

    private CollectorInstaller() {}

    public static @NotNull Path insightDirectory() {
        return Path.of(System.getProperty("user.home"), ".agent-insight");
    }

    public static void installAsync(@NotNull JetBrainsMarkerService markerService) {
        if (!INSTALLING.compareAndSet(false, true)) return;
        markerService.setCollectorStatus("Installing");
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                install(markerService);
            } finally {
                INSTALLING.set(false);
            }
        });
    }

    private static void install(JetBrainsMarkerService markerService) {
        try {
            Map<String, String> config = readConfig();
            if (config.getOrDefault("AGENT_INSIGHT_HOST", "").isBlank()
                    || config.getOrDefault("AGENT_INSIGHT_API_KEY", "").isBlank()) {
                markerService.setCollectorStatus("Needs configuration");
                return;
            }
            Path runtime = insightDirectory().resolve("qoder-jetbrains").resolve("runtime");
            Files.createDirectories(runtime);
            for (String file : RUNTIME_FILES) copyResource("/collector/" + file, runtime.resolve(file));

            Process process = new ProcessBuilder(
                    "node",
                    runtime.resolve("qoder_setup.mjs").toString(),
                    "install",
                    "--from-config",
                    "--scope=user",
                    "--product=jetbrains",
                    "--owner=jetbrains"
            ).redirectErrorStream(true).start();
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            Thread reader = new Thread(() -> {
                try (InputStream input = process.getInputStream()) {
                    input.transferTo(output);
                } catch (IOException ignored) {}
            }, "agent-insight-qoder-installer-output");
            reader.setDaemon(true);
            reader.start();
            if (!process.waitFor(20, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new IOException("Qoder collector setup timed out");
            }
            reader.join(Duration.ofSeconds(1).toMillis());
            if (process.exitValue() != 0) {
                String detail = output.toString(StandardCharsets.UTF_8).trim();
                throw new IOException(detail.isBlank() ? "Qoder collector setup failed" : detail);
            }
            markerService.setCollectorStatus("Active · Qoder for JetBrains");
        } catch (Exception error) {
            LOG.warn("Unable to install the Agent Insight Qoder collector", error);
            markerService.setCollectorStatus("Setup failed: " + concise(error.getMessage()));
        }
    }

    public static void uninstallOwnedCollector() {
        Path runtime = insightDirectory().resolve("qoder-jetbrains").resolve("runtime");
        Path uninstaller = runtime.resolve("qoder_jetbrains_uninstall.mjs");
        if (!Files.exists(uninstaller)) return;
        try {
            new ProcessBuilder("node", uninstaller.toString(), runtime.toString())
                    .redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start();
        } catch (IOException error) {
            LOG.warn("Unable to start Qoder for JetBrains collector cleanup", error);
        }
    }

    public static void flushOwnedCollector() {
        Path runtime = insightDirectory().resolve("qoder-jetbrains").resolve("runtime");
        Path collector = runtime.resolve("qoder_trace_collector.mjs");
        if (!Files.exists(collector)) return;
        if (!FLUSHED.compareAndSet(false, true)) return;
        try {
            Process process = new ProcessBuilder(
                    "node",
                    collector.toString(),
                    "--flush",
                    "--product=jetbrains",
                    "--wait-for-lock-ms=5000"
            ).redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start();
            if (!process.waitFor(20, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                LOG.warn("Qoder for JetBrains collector flush timed out; pending spool is preserved");
            } else if (process.exitValue() != 0) {
                LOG.warn("Qoder for JetBrains collector flush failed; pending spool is preserved");
            }
        } catch (Exception error) {
            LOG.warn("Unable to flush the Agent Insight Qoder collector; pending spool is preserved", error);
        }
    }

    private static void copyResource(String resourceName, Path target) throws IOException {
        try (InputStream input = CollectorInstaller.class.getResourceAsStream(resourceName)) {
            if (input == null) throw new IOException("Missing plugin resource " + resourceName);
            byte[] bytes = input.readAllBytes();
            if (Files.exists(target) && java.util.Arrays.equals(bytes, Files.readAllBytes(target))) return;
            Files.createDirectories(target.getParent());
            Path temporary = target.resolveSibling(target.getFileName() + ".tmp");
            Files.write(temporary, bytes);
            try {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException ignored) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }

    public static @NotNull Map<String, String> readConfig() {
        Map<String, String> values = new LinkedHashMap<>();
        Path config = insightDirectory().resolve("config");
        try {
            for (String line : Files.readAllLines(config, StandardCharsets.UTF_8)) {
                int equals = line.indexOf('=');
                if (equals > 0) values.put(line.substring(0, equals), line.substring(equals + 1));
            }
        } catch (IOException ignored) {}
        return values;
    }

    public static void writeConnectionConfig(@NotNull String host, @NotNull String apiKey) throws IOException {
        Map<String, String> values = readConfig();
        values.put("AGENT_INSIGHT_HOST", host.strip().replaceAll("/+$", ""));
        values.put("AGENT_INSIGHT_API_KEY", apiKey.strip());
        Path config = insightDirectory().resolve("config");
        Files.createDirectories(config.getParent());
        StringBuilder text = new StringBuilder();
        for (Map.Entry<String, String> entry : values.entrySet()) {
            text.append(entry.getKey()).append('=').append(entry.getValue()).append('\n');
        }
        Path temporary = config.resolveSibling("config.tmp");
        Files.writeString(temporary, text, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        try {
            Files.move(temporary, config, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException ignored) {
            Files.move(temporary, config, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static String concise(String message) {
        String value = String.valueOf(message == null ? "unknown error" : message).replace('\r', ' ').replace('\n', ' ').strip();
        return value.length() > 100 ? value.substring(0, 100) + "…" : value;
    }
}
