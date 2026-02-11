package com.abap.doc.plugin.dag;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.function.Consumer;

import org.eclipse.core.runtime.Platform;
import org.osgi.framework.Bundle;

import com.abap.doc.plugin.Activator;

public class DagRunner {

    private static java.nio.file.Path cachedScriptPath;

    public String buildDag(String systemUrl, String client, String username, String password,
                           String objectName, String objectType,
                           Consumer<String> progressCallback) throws IOException, InterruptedException {

        String input = buildInputJson(systemUrl, client, username, password, objectName, objectType);
        String scriptPath = resolveScriptPath();

        ProcessBuilder pb = new ProcessBuilder("node", scriptPath);
        pb.redirectErrorStream(false);
        Process process = pb.start();

        try (OutputStream stdin = process.getOutputStream()) {
            stdin.write(input.getBytes(StandardCharsets.UTF_8));
            stdin.flush();
        }

        // Read stderr in a separate thread for progress reporting
        Thread stderrThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (progressCallback != null) {
                        progressCallback.accept(line);
                    }
                }
            } catch (IOException e) {
                // ignore
            }
        }, "dag-builder-stderr");
        stderrThread.setDaemon(true);
        stderrThread.start();

        String stdout = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);

        int exitCode = process.waitFor();
        stderrThread.join(5000);

        if (exitCode != 0) {
            throw new IOException("DAG builder failed (exit " + exitCode + ")");
        }

        return stdout;
    }

    private synchronized String resolveScriptPath() throws IOException {
        if (cachedScriptPath != null && Files.exists(cachedScriptPath)) {
            return cachedScriptPath.toString();
        }

        Bundle bundle = Platform.getBundle(Activator.PLUGIN_ID);
        URL entry = bundle.getEntry("node/dag-builder.js");
        if (entry == null) {
            throw new IOException("DAG builder script not found in plugin bundle. "
                + "Bundle location: " + bundle.getLocation());
        }

        java.nio.file.Path tempFile = Files.createTempFile("abap-doc-dag-builder-", ".js");
        tempFile.toFile().deleteOnExit();

        try (InputStream in = entry.openStream()) {
            Files.copy(in, tempFile, StandardCopyOption.REPLACE_EXISTING);
        }

        cachedScriptPath = tempFile;
        return cachedScriptPath.toString();
    }

    private static String buildInputJson(String systemUrl, String client, String username,
                                          String password, String objectName, String objectType) {
        return String.format(
            "{\"systemUrl\":\"%s\",\"client\":\"%s\",\"username\":\"%s\",\"password\":\"%s\",\"objectName\":\"%s\",\"objectType\":\"%s\"}",
            escapeJson(systemUrl), escapeJson(client), escapeJson(username),
            escapeJson(password), escapeJson(objectName), escapeJson(objectType)
        );
    }

    private static String escapeJson(String value) {
        if (value == null) return "";
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
