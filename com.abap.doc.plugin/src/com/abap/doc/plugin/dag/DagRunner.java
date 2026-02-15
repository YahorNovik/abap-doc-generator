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
import java.util.Map;
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
        return runScript(input, progressCallback);
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

    public String generateDoc(String systemUrl, String client, String username, String password,
                              String objectName, String objectType,
                              String summaryProvider, String summaryApiKey, String summaryModel, String summaryBaseUrl,
                              String docProvider, String docApiKey, String docModel, String docBaseUrl,
                              int maxTotalTokens,
                              String templateType, String templateCustom,
                              String userContext,
                              Consumer<String> progressCallback) throws IOException, InterruptedException {

        String input = buildDocInputJson(systemUrl, client, username, password, objectName, objectType,
            summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl,
            docProvider, docApiKey, docModel, docBaseUrl, maxTotalTokens,
            templateType, templateCustom, userContext);
        return runScript(input, progressCallback);
    }

    public String listPackageObjects(String systemUrl, String client, String username, String password,
                                      String packageName, int maxSubPackageDepth,
                                      Consumer<String> progressCallback) throws IOException, InterruptedException {
        String input = buildListObjectsInputJson(systemUrl, client, username, password,
            packageName, maxSubPackageDepth);
        return runScript(input, progressCallback);
    }

    public String triagePackage(String systemUrl, String client, String username, String password,
                                String packageName,
                                String summaryProvider, String summaryApiKey, String summaryModel, String summaryBaseUrl,
                                int maxSubPackageDepth,
                                String[] excludedObjects,
                                Consumer<String> progressCallback) throws IOException, InterruptedException {
        String input = buildTriageInputJson(systemUrl, client, username, password, packageName,
            summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl,
            maxSubPackageDepth, excludedObjects);
        return runScript(input, progressCallback);
    }

    public String generatePackageDoc(String systemUrl, String client, String username, String password,
                                     String packageName,
                                     String summaryProvider, String summaryApiKey, String summaryModel, String summaryBaseUrl,
                                     String docProvider, String docApiKey, String docModel, String docBaseUrl,
                                     int maxTotalTokens,
                                     String templateType, String templateCustom,
                                     String userContext,
                                     int maxSubPackageDepth,
                                     String[] excludedObjects,
                                     String[] fullDocObjects,
                                     Map<String, String> precomputedSummaries,
                                     Map<String, String> precomputedClusterSummaries,
                                     Map<String, String[]> precomputedClusterAssignments,
                                     Consumer<String> progressCallback) throws IOException, InterruptedException {

        String input = buildPackageDocInputJson(systemUrl, client, username, password, packageName,
            summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl,
            docProvider, docApiKey, docModel, docBaseUrl, maxTotalTokens,
            templateType, templateCustom, userContext, maxSubPackageDepth, excludedObjects,
            fullDocObjects, precomputedSummaries, precomputedClusterSummaries, precomputedClusterAssignments);
        return runScript(input, progressCallback);
    }

    private String runScript(String input, Consumer<String> progressCallback) throws IOException, InterruptedException {
        String scriptPath = resolveScriptPath();

        ProcessBuilder pb = new ProcessBuilder("node", scriptPath);
        pb.redirectErrorStream(false);
        Process process = pb.start();

        try (OutputStream stdin = process.getOutputStream()) {
            stdin.write(input.getBytes(StandardCharsets.UTF_8));
            stdin.flush();
        }

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
            throw new IOException("Script failed (exit " + exitCode + ")");
        }

        return stdout;
    }

    private static String buildInputJson(String systemUrl, String client, String username,
                                          String password, String objectName, String objectType) {
        return String.format(
            "{\"systemUrl\":\"%s\",\"client\":\"%s\",\"username\":\"%s\",\"password\":\"%s\",\"objectName\":\"%s\",\"objectType\":\"%s\"}",
            escapeJson(systemUrl), escapeJson(client), escapeJson(username),
            escapeJson(password), escapeJson(objectName), escapeJson(objectType)
        );
    }

    private static String buildDocInputJson(String systemUrl, String client, String username, String password,
                                             String objectName, String objectType,
                                             String summaryProvider, String summaryApiKey, String summaryModel, String summaryBaseUrl,
                                             String docProvider, String docApiKey, String docModel, String docBaseUrl,
                                             int maxTotalTokens,
                                             String templateType, String templateCustom,
                                             String userContext) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"command\":\"generate-doc\"");
        sb.append(",\"systemUrl\":\"").append(escapeJson(systemUrl)).append("\"");
        sb.append(",\"client\":\"").append(escapeJson(client)).append("\"");
        sb.append(",\"username\":\"").append(escapeJson(username)).append("\"");
        sb.append(",\"password\":\"").append(escapeJson(password)).append("\"");
        sb.append(",\"objectName\":\"").append(escapeJson(objectName)).append("\"");
        sb.append(",\"objectType\":\"").append(escapeJson(objectType)).append("\"");
        sb.append(",\"summaryLlm\":{");
        sb.append("\"provider\":\"").append(escapeJson(summaryProvider)).append("\"");
        sb.append(",\"apiKey\":\"").append(escapeJson(summaryApiKey)).append("\"");
        sb.append(",\"model\":\"").append(escapeJson(summaryModel)).append("\"");
        if (summaryBaseUrl != null && !summaryBaseUrl.isEmpty()) {
            sb.append(",\"baseUrl\":\"").append(escapeJson(summaryBaseUrl)).append("\"");
        }
        sb.append("}");
        sb.append(",\"docLlm\":{");
        sb.append("\"provider\":\"").append(escapeJson(docProvider)).append("\"");
        sb.append(",\"apiKey\":\"").append(escapeJson(docApiKey)).append("\"");
        sb.append(",\"model\":\"").append(escapeJson(docModel)).append("\"");
        if (docBaseUrl != null && !docBaseUrl.isEmpty()) {
            sb.append(",\"baseUrl\":\"").append(escapeJson(docBaseUrl)).append("\"");
        }
        sb.append("}");
        if (maxTotalTokens > 0) {
            sb.append(",\"maxTotalTokens\":").append(maxTotalTokens);
        }
        if (templateType != null && !templateType.isEmpty()) {
            sb.append(",\"templateType\":\"").append(escapeJson(templateType)).append("\"");
        }
        if (templateCustom != null && !templateCustom.isEmpty()) {
            sb.append(",\"templateCustom\":\"").append(escapeJson(templateCustom)).append("\"");
        }
        if (userContext != null && !userContext.isEmpty()) {
            sb.append(",\"userContext\":\"").append(escapeJson(userContext)).append("\"");
        }
        sb.append("}");
        return sb.toString();
    }

    private static String buildListObjectsInputJson(String systemUrl, String client, String username,
                                                     String password, String packageName,
                                                     int maxSubPackageDepth) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"command\":\"list-package-objects\"");
        sb.append(",\"systemUrl\":\"").append(escapeJson(systemUrl)).append("\"");
        sb.append(",\"client\":\"").append(escapeJson(client)).append("\"");
        sb.append(",\"username\":\"").append(escapeJson(username)).append("\"");
        sb.append(",\"password\":\"").append(escapeJson(password)).append("\"");
        sb.append(",\"packageName\":\"").append(escapeJson(packageName)).append("\"");
        if (maxSubPackageDepth > 0) {
            sb.append(",\"maxSubPackageDepth\":").append(maxSubPackageDepth);
        }
        sb.append("}");
        return sb.toString();
    }

    private static String buildTriageInputJson(String systemUrl, String client, String username, String password,
                                                String packageName,
                                                String summaryProvider, String summaryApiKey, String summaryModel, String summaryBaseUrl,
                                                int maxSubPackageDepth,
                                                String[] excludedObjects) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"command\":\"triage-package\"");
        sb.append(",\"systemUrl\":\"").append(escapeJson(systemUrl)).append("\"");
        sb.append(",\"client\":\"").append(escapeJson(client)).append("\"");
        sb.append(",\"username\":\"").append(escapeJson(username)).append("\"");
        sb.append(",\"password\":\"").append(escapeJson(password)).append("\"");
        sb.append(",\"packageName\":\"").append(escapeJson(packageName)).append("\"");
        sb.append(",\"summaryLlm\":{");
        sb.append("\"provider\":\"").append(escapeJson(summaryProvider)).append("\"");
        sb.append(",\"apiKey\":\"").append(escapeJson(summaryApiKey)).append("\"");
        sb.append(",\"model\":\"").append(escapeJson(summaryModel)).append("\"");
        if (summaryBaseUrl != null && !summaryBaseUrl.isEmpty()) {
            sb.append(",\"baseUrl\":\"").append(escapeJson(summaryBaseUrl)).append("\"");
        }
        sb.append("}");
        if (maxSubPackageDepth > 0) {
            sb.append(",\"maxSubPackageDepth\":").append(maxSubPackageDepth);
        }
        if (excludedObjects != null && excludedObjects.length > 0) {
            sb.append(",\"excludedObjects\":[");
            for (int i = 0; i < excludedObjects.length; i++) {
                if (i > 0) sb.append(",");
                sb.append("\"").append(escapeJson(excludedObjects[i])).append("\"");
            }
            sb.append("]");
        }
        sb.append("}");
        return sb.toString();
    }

    private static String buildPackageDocInputJson(String systemUrl, String client, String username, String password,
                                                    String packageName,
                                                    String summaryProvider, String summaryApiKey, String summaryModel, String summaryBaseUrl,
                                                    String docProvider, String docApiKey, String docModel, String docBaseUrl,
                                                    int maxTotalTokens,
                                                    String templateType, String templateCustom,
                                                    String userContext,
                                                    int maxSubPackageDepth,
                                                    String[] excludedObjects,
                                                    String[] fullDocObjects,
                                                    Map<String, String> precomputedSummaries,
                                                    Map<String, String> precomputedClusterSummaries,
                                                    Map<String, String[]> precomputedClusterAssignments) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"command\":\"generate-package-doc\"");
        sb.append(",\"systemUrl\":\"").append(escapeJson(systemUrl)).append("\"");
        sb.append(",\"client\":\"").append(escapeJson(client)).append("\"");
        sb.append(",\"username\":\"").append(escapeJson(username)).append("\"");
        sb.append(",\"password\":\"").append(escapeJson(password)).append("\"");
        sb.append(",\"packageName\":\"").append(escapeJson(packageName)).append("\"");
        sb.append(",\"summaryLlm\":{");
        sb.append("\"provider\":\"").append(escapeJson(summaryProvider)).append("\"");
        sb.append(",\"apiKey\":\"").append(escapeJson(summaryApiKey)).append("\"");
        sb.append(",\"model\":\"").append(escapeJson(summaryModel)).append("\"");
        if (summaryBaseUrl != null && !summaryBaseUrl.isEmpty()) {
            sb.append(",\"baseUrl\":\"").append(escapeJson(summaryBaseUrl)).append("\"");
        }
        sb.append("}");
        sb.append(",\"docLlm\":{");
        sb.append("\"provider\":\"").append(escapeJson(docProvider)).append("\"");
        sb.append(",\"apiKey\":\"").append(escapeJson(docApiKey)).append("\"");
        sb.append(",\"model\":\"").append(escapeJson(docModel)).append("\"");
        if (docBaseUrl != null && !docBaseUrl.isEmpty()) {
            sb.append(",\"baseUrl\":\"").append(escapeJson(docBaseUrl)).append("\"");
        }
        sb.append("}");
        if (maxTotalTokens > 0) {
            sb.append(",\"maxTotalTokens\":").append(maxTotalTokens);
        }
        if (templateType != null && !templateType.isEmpty()) {
            sb.append(",\"templateType\":\"").append(escapeJson(templateType)).append("\"");
        }
        if (templateCustom != null && !templateCustom.isEmpty()) {
            sb.append(",\"templateCustom\":\"").append(escapeJson(templateCustom)).append("\"");
        }
        if (userContext != null && !userContext.isEmpty()) {
            sb.append(",\"userContext\":\"").append(escapeJson(userContext)).append("\"");
        }
        if (maxSubPackageDepth > 0) {
            sb.append(",\"maxSubPackageDepth\":").append(maxSubPackageDepth);
        }
        if (excludedObjects != null && excludedObjects.length > 0) {
            sb.append(",\"excludedObjects\":[");
            for (int i = 0; i < excludedObjects.length; i++) {
                if (i > 0) sb.append(",");
                sb.append("\"").append(escapeJson(excludedObjects[i])).append("\"");
            }
            sb.append("]");
        }
        if (fullDocObjects != null && fullDocObjects.length > 0) {
            sb.append(",\"fullDocObjects\":[");
            for (int i = 0; i < fullDocObjects.length; i++) {
                if (i > 0) sb.append(",");
                sb.append("\"").append(escapeJson(fullDocObjects[i])).append("\"");
            }
            sb.append("]");
        }
        if (precomputedSummaries != null && !precomputedSummaries.isEmpty()) {
            sb.append(",\"precomputedSummaries\":{");
            boolean first = true;
            for (Map.Entry<String, String> entry : precomputedSummaries.entrySet()) {
                if (!first) sb.append(",");
                sb.append("\"").append(escapeJson(entry.getKey())).append("\":\"").append(escapeJson(entry.getValue())).append("\"");
                first = false;
            }
            sb.append("}");
        }
        if (precomputedClusterSummaries != null && !precomputedClusterSummaries.isEmpty()) {
            sb.append(",\"precomputedClusterSummaries\":{");
            boolean first = true;
            for (Map.Entry<String, String> entry : precomputedClusterSummaries.entrySet()) {
                if (!first) sb.append(",");
                sb.append("\"").append(escapeJson(entry.getKey())).append("\":\"").append(escapeJson(entry.getValue())).append("\"");
                first = false;
            }
            sb.append("}");
        }
        if (precomputedClusterAssignments != null && !precomputedClusterAssignments.isEmpty()) {
            sb.append(",\"precomputedClusterAssignments\":{");
            boolean first = true;
            for (Map.Entry<String, String[]> entry : precomputedClusterAssignments.entrySet()) {
                if (!first) sb.append(",");
                sb.append("\"").append(escapeJson(entry.getKey())).append("\":[");
                String[] names = entry.getValue();
                for (int i = 0; i < names.length; i++) {
                    if (i > 0) sb.append(",");
                    sb.append("\"").append(escapeJson(names[i])).append("\"");
                }
                sb.append("]");
                first = false;
            }
            sb.append("}");
        }
        sb.append("}");
        return sb.toString();
    }

    public String exportPdf(String markdown, String title,
                            Consumer<String> progressCallback) throws IOException, InterruptedException {
        String input = buildExportInputJson("export-pdf", markdown, title);
        return runScript(input, progressCallback);
    }

    public String exportDocx(String markdown, String title,
                             Consumer<String> progressCallback) throws IOException, InterruptedException {
        String input = buildExportInputJson("export-docx", markdown, title);
        return runScript(input, progressCallback);
    }

    private static String buildExportInputJson(String command, String markdown, String title) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"command\":\"").append(escapeJson(command)).append("\"");
        sb.append(",\"markdown\":\"").append(escapeJson(markdown)).append("\"");
        sb.append(",\"title\":\"").append(escapeJson(title)).append("\"");
        sb.append("}");
        return sb.toString();
    }

    public String chat(String systemUrl, String client, String username, String password,
                       String objectName, String objectType,
                       String documentation, String userContext,
                       String conversationJson,
                       String docProvider, String docApiKey, String docModel, String docBaseUrl,
                       boolean isPackage,
                       Consumer<String> progressCallback) throws IOException, InterruptedException {

        String input = buildChatInputJson(systemUrl, client, username, password,
            objectName, objectType, documentation, userContext, conversationJson,
            docProvider, docApiKey, docModel, docBaseUrl, isPackage);
        return runScript(input, progressCallback);
    }

    private static String buildChatInputJson(String systemUrl, String client, String username, String password,
                                              String objectName, String objectType,
                                              String documentation, String userContext,
                                              String conversationJson,
                                              String docProvider, String docApiKey, String docModel, String docBaseUrl,
                                              boolean isPackage) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"command\":\"chat\"");
        sb.append(",\"systemUrl\":\"").append(escapeJson(systemUrl)).append("\"");
        sb.append(",\"client\":\"").append(escapeJson(client)).append("\"");
        sb.append(",\"username\":\"").append(escapeJson(username)).append("\"");
        sb.append(",\"password\":\"").append(escapeJson(password)).append("\"");
        sb.append(",\"objectName\":\"").append(escapeJson(objectName)).append("\"");
        sb.append(",\"objectType\":\"").append(escapeJson(objectType)).append("\"");
        sb.append(",\"documentation\":\"").append(escapeJson(documentation)).append("\"");
        if (userContext != null && !userContext.isEmpty()) {
            sb.append(",\"userContext\":\"").append(escapeJson(userContext)).append("\"");
        }
        sb.append(",\"conversation\":").append(conversationJson);
        if (isPackage) {
            sb.append(",\"isPackage\":true");
        }
        sb.append(",\"docLlm\":{");
        sb.append("\"provider\":\"").append(escapeJson(docProvider)).append("\"");
        sb.append(",\"apiKey\":\"").append(escapeJson(docApiKey)).append("\"");
        sb.append(",\"model\":\"").append(escapeJson(docModel)).append("\"");
        if (docBaseUrl != null && !docBaseUrl.isEmpty()) {
            sb.append(",\"baseUrl\":\"").append(escapeJson(docBaseUrl)).append("\"");
        }
        sb.append("}}");
        return sb.toString();
    }

    public static String escapeJson(String value) {
        if (value == null) return "";
        return value.replace("\\", "\\\\")
                     .replace("\"", "\\\"")
                     .replace("\n", "\\n")
                     .replace("\r", "\\r")
                     .replace("\t", "\\t");
    }
}
