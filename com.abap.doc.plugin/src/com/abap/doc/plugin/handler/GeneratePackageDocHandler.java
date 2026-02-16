package com.abap.doc.plugin.handler;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.commands.ExecutionException;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Status;
import org.eclipse.core.runtime.jobs.Job;
import org.eclipse.jface.dialogs.InputDialog;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.jface.preference.IPreferenceStore;
import org.eclipse.jface.window.Window;
import org.eclipse.swt.widgets.Display;
import org.eclipse.swt.widgets.Shell;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.PlatformUI;
import org.eclipse.ui.handlers.HandlerUtil;

import com.abap.doc.plugin.Activator;
import com.abap.doc.plugin.GenerationResult;
import com.abap.doc.plugin.PluginConsole;
import com.abap.doc.plugin.chat.ChatView;
import com.abap.doc.plugin.dag.DagRunner;
import com.abap.doc.plugin.preferences.ConnectionPreferencePage;

public class GeneratePackageDocHandler extends AbstractHandler {

    @Override
    public Object execute(ExecutionEvent event) throws ExecutionException {
        Shell shell = HandlerUtil.getActiveShell(event);
        Display display = shell.getDisplay();
        IPreferenceStore store = Activator.getDefault().getPreferenceStore();

        // SAP connection
        String systemUrl = store.getString(ConnectionPreferencePage.PREF_SYSTEM_URL);
        String client = store.getString(ConnectionPreferencePage.PREF_CLIENT);
        String username = store.getString(ConnectionPreferencePage.PREF_USERNAME);
        String password = store.getString(ConnectionPreferencePage.PREF_PASSWORD);

        if (systemUrl.isBlank() || username.isBlank()) {
            MessageDialog.openError(shell, "ABAP Doc Generator",
                "Please configure SAP connection in Preferences > ABAP Doc Generator");
            return null;
        }

        // LLM configs
        String summaryProvider = store.getString(ConnectionPreferencePage.PREF_SUMMARY_PROVIDER);
        String summaryApiKey = store.getString(ConnectionPreferencePage.PREF_SUMMARY_API_KEY);
        String summaryModel = store.getString(ConnectionPreferencePage.PREF_SUMMARY_MODEL);
        String summaryBaseUrl = store.getString(ConnectionPreferencePage.PREF_SUMMARY_BASE_URL);

        String docProvider = store.getString(ConnectionPreferencePage.PREF_DOC_PROVIDER);
        String docApiKey = store.getString(ConnectionPreferencePage.PREF_DOC_API_KEY);
        String docModel = store.getString(ConnectionPreferencePage.PREF_DOC_MODEL);
        String docBaseUrl = store.getString(ConnectionPreferencePage.PREF_DOC_BASE_URL);

        // Token budget
        int maxTotalTokens = store.getInt(ConnectionPreferencePage.PREF_MAX_TOKENS);

        // Documentation template
        String templateType = store.getString(ConnectionPreferencePage.PREF_TEMPLATE);
        String templateCustom = store.getString(ConnectionPreferencePage.PREF_TEMPLATE_CUSTOM);

        // Sub-package depth
        int maxSubPackageDepth = store.getInt(ConnectionPreferencePage.PREF_MAX_SUBPACKAGE_DEPTH);
        if (maxSubPackageDepth <= 0) maxSubPackageDepth = 2;

        if (summaryApiKey.isBlank() || summaryModel.isBlank() || docApiKey.isBlank() || docModel.isBlank()) {
            MessageDialog.openError(shell, "ABAP Doc Generator",
                "Please configure LLM settings in Preferences > ABAP Doc Generator");
            return null;
        }

        // Prompt for package name
        InputDialog dialog = new InputDialog(shell, "Generate Package Documentation",
            "Enter the ABAP package name (e.g., ZFINANCE):", "", input -> {
                if (input == null || input.trim().isEmpty()) {
                    return "Package name cannot be empty";
                }
                return null;
            });

        if (dialog.open() != Window.OK) {
            return null;
        }

        String packageName = dialog.getValue().trim().toUpperCase();

        // Optional context dialog
        String userContext = "";
        MultiLineInputDialog ctxDialog = new MultiLineInputDialog(shell,
            "Additional Context (Optional)",
            "Provide any business context, domain notes, or special instructions for documentation generation.",
            "");
        if (ctxDialog.open() == Window.OK) {
            userContext = ctxDialog.getValue();
        }

        final int fMaxTotalTokens = maxTotalTokens;
        final String fTemplateType = templateType;
        final String fTemplateCustom = templateCustom;
        final String fUserContext = userContext;
        final int fMaxSubPackageDepth = maxSubPackageDepth;

        // Phase 1: Fetch object list from SAP
        Job listJob = new Job("Fetching package objects for " + packageName) {
            @Override
            protected IStatus run(IProgressMonitor monitor) {
                monitor.beginTask("Discovering package objects...", IProgressMonitor.UNKNOWN);
                PluginConsole.clear();
                PluginConsole.show();
                PluginConsole.println("Discovering objects in package " + packageName + "...");
                try {
                    DagRunner runner = new DagRunner();
                    String objectListJson = runner.listPackageObjects(
                        systemUrl, client, username, password,
                        packageName, fMaxSubPackageDepth,
                        line -> {
                            monitor.subTask(line);
                            PluginConsole.println(line);
                        });

                    List<ObjectSelectionDialog.PackageObjectItem> objects = parseObjectList(objectListJson);
                    PluginConsole.println("Found " + objects.size() + " objects.");

                    if (objects.isEmpty()) {
                        display.asyncExec(() ->
                            MessageDialog.openInformation(shell, "ABAP Doc Generator",
                                "No relevant custom objects found in package " + packageName));
                        return Status.OK_STATUS;
                    }

                    // Show selection dialog on UI thread AFTER the job completes
                    display.asyncExec(() -> showObjectSelectionAndContinue(
                        shell, display, objects, packageName,
                        systemUrl, client, username, password,
                        summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl,
                        docProvider, docApiKey, docModel, docBaseUrl,
                        fMaxTotalTokens, fTemplateType, fTemplateCustom, fUserContext,
                        fMaxSubPackageDepth));

                    return Status.OK_STATUS;
                } catch (Exception e) {
                    display.asyncExec(() ->
                        MessageDialog.openError(shell, "ABAP Doc Generator",
                            "Failed to fetch package objects: " + e.getMessage()));
                    return Status.error("Failed to fetch package objects", e);
                } finally {
                    monitor.done();
                }
            }
        };
        listJob.setUser(true);
        listJob.schedule();

        return null;
    }

    /**
     * Shows the ObjectSelectionDialog on the UI thread, then starts Phase 2 (triage).
     */
    private void showObjectSelectionAndContinue(
            Shell shell, Display display,
            List<ObjectSelectionDialog.PackageObjectItem> objects, String packageName,
            String systemUrl, String client, String username, String password,
            String summaryProvider, String summaryApiKey, String summaryModel, String summaryBaseUrl,
            String docProvider, String docApiKey, String docModel, String docBaseUrl,
            int maxTotalTokens, String templateType, String templateCustom, String userContext,
            int maxSubPackageDepth) {

        ObjectSelectionDialog selDialog = new ObjectSelectionDialog(shell, objects);
        if (selDialog.open() != Window.OK) {
            PluginConsole.println("Object selection cancelled by user.");
            return;
        }

        String[] excludedObjects = selDialog.getExcludedObjects();
        PluginConsole.println("Excluded " + excludedObjects.length + " objects from documentation.");

        // Phase 2: Triage
        Job triageJob = new Job("Analyzing objects in " + packageName) {
            @Override
            protected IStatus run(IProgressMonitor triageMonitor) {
                triageMonitor.beginTask("Summarizing and triaging objects...", IProgressMonitor.UNKNOWN);
                PluginConsole.println("Phase 2: Summarizing and triaging objects in " + packageName + "...");
                try {
                    DagRunner triageRunner = new DagRunner();
                    String triageJson = triageRunner.triagePackage(
                        systemUrl, client, username, password,
                        packageName,
                        summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl,
                        maxSubPackageDepth,
                        excludedObjects,
                        line -> {
                            triageMonitor.subTask(line);
                            PluginConsole.println(line);
                        });

                    List<TriageReviewDialog.TriageObjectItem> triageItems = parseTriageResult(triageJson);
                    PluginConsole.println("Triage complete: " + triageItems.size() + " objects analyzed.");

                    if (triageItems.isEmpty()) {
                        display.asyncExec(() ->
                            MessageDialog.openInformation(shell, "ABAP Doc Generator",
                                "No objects to document in package " + packageName));
                        return Status.OK_STATUS;
                    }

                    Map<String, String> precomputedSummaries = extractSummariesFromTriage(triageJson);
                    Map<String, String> precomputedClusterSummaries = extractClusterSummariesFromTriage(triageJson);
                    Map<String, String[]> precomputedClusterAssignments = extractClusterAssignmentsFromTriage(triageJson);

                    // Show triage review dialog on UI thread AFTER the job completes
                    display.asyncExec(() -> showTriageReviewAndContinue(
                        shell, display, triageItems, packageName,
                        systemUrl, client, username, password,
                        summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl,
                        docProvider, docApiKey, docModel, docBaseUrl,
                        maxTotalTokens, templateType, templateCustom, userContext,
                        maxSubPackageDepth, excludedObjects,
                        precomputedSummaries, precomputedClusterSummaries, precomputedClusterAssignments));

                    return Status.OK_STATUS;
                } catch (Exception e) {
                    display.asyncExec(() ->
                        MessageDialog.openError(shell, "ABAP Doc Generator",
                            "Failed to triage package objects: " + e.getMessage()));
                    return Status.error("Package triage failed", e);
                } finally {
                    triageMonitor.done();
                }
            }
        };
        triageJob.setUser(true);
        triageJob.schedule();
    }

    /**
     * Shows the TriageReviewDialog on the UI thread, then starts Phase 3 (generation).
     */
    private void showTriageReviewAndContinue(
            Shell shell, Display display,
            List<TriageReviewDialog.TriageObjectItem> triageItems, String packageName,
            String systemUrl, String client, String username, String password,
            String summaryProvider, String summaryApiKey, String summaryModel, String summaryBaseUrl,
            String docProvider, String docApiKey, String docModel, String docBaseUrl,
            int maxTotalTokens, String templateType, String templateCustom, String userContext,
            int maxSubPackageDepth, String[] excludedObjects,
            Map<String, String> precomputedSummaries,
            Map<String, String> precomputedClusterSummaries,
            Map<String, String[]> precomputedClusterAssignments) {

        TriageReviewDialog triageDialog = new TriageReviewDialog(shell, triageItems);
        if (triageDialog.open() != Window.OK) {
            PluginConsole.println("Triage review cancelled by user.");
            return;
        }

        String[] fullDocObjects = triageDialog.getFullDocObjects();
        PluginConsole.println(fullDocObjects.length + " objects selected for full documentation.");

        // Check if we should show the standalone reassignment dialog
        // Find named clusters (not "Standalone Objects") and standalone objects
        List<StandaloneReassignDialog.ClusterInfo> namedClusters = new ArrayList<>();
        List<StandaloneReassignDialog.StandaloneItem> standaloneItems2 = new ArrayList<>();
        String[] namedClusterNames = extractNamedClusters(precomputedClusterAssignments, precomputedClusterSummaries, namedClusters);

        if (namedClusterNames.length > 0 && precomputedClusterAssignments != null) {
            // Find objects in "Standalone Objects" cluster
            for (Map.Entry<String, String[]> entry : precomputedClusterAssignments.entrySet()) {
                String key = entry.getKey();
                // Match "Standalone Objects" or "SUBPKG::Standalone Objects"
                String clusterName = key.contains("::") ? key.substring(key.indexOf("::") + 2) : key;
                if ("Standalone Objects".equals(clusterName)) {
                    for (String objName : entry.getValue()) {
                        String summary = precomputedSummaries != null ? precomputedSummaries.getOrDefault(objName, "") : "";
                        String type = "";
                        for (TriageReviewDialog.TriageObjectItem ti : triageItems) {
                            if (ti.name.equals(objName)) {
                                type = ti.type;
                                if (summary.isEmpty()) summary = ti.summary;
                                break;
                            }
                        }
                        standaloneItems2.add(new StandaloneReassignDialog.StandaloneItem(objName, type, summary));
                    }
                }
            }
        }

        // Apply standalone reassignments to cluster assignments
        final Map<String, String[]> finalClusterAssignments;
        if (!standaloneItems2.isEmpty() && namedClusterNames.length > 0) {
            StandaloneReassignDialog reassignDialog = new StandaloneReassignDialog(
                shell, standaloneItems2, namedClusterNames, namedClusters,
                summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl);
            if (reassignDialog.open() == Window.OK) {
                Map<String, String> reassignments = reassignDialog.getReassignments();
                if (!reassignments.isEmpty()) {
                    finalClusterAssignments = applyReassignments(precomputedClusterAssignments, reassignments);
                    PluginConsole.println(reassignments.size() + " standalone objects reassigned to groups.");
                } else {
                    finalClusterAssignments = precomputedClusterAssignments;
                }
            } else {
                finalClusterAssignments = precomputedClusterAssignments;
                PluginConsole.println("Standalone reassignment skipped.");
            }
        } else {
            finalClusterAssignments = precomputedClusterAssignments;
        }

        // Phase 3: Generate documentation
        Job genJob = new Job("Generating package documentation for " + packageName) {
            @Override
            protected IStatus run(IProgressMonitor genMonitor) {
                genMonitor.beginTask("Generating package documentation...", IProgressMonitor.UNKNOWN);
                PluginConsole.println("Phase 3: Generating documentation for " + packageName + "...");
                try {
                    DagRunner genRunner = new DagRunner();
                    String resultJson = genRunner.generatePackageDoc(
                        systemUrl, client, username, password,
                        packageName,
                        summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl,
                        docProvider, docApiKey, docModel, docBaseUrl,
                        maxTotalTokens,
                        templateType, templateCustom,
                        userContext,
                        maxSubPackageDepth,
                        excludedObjects,
                        fullDocObjects,
                        precomputedSummaries,
                        precomputedClusterSummaries,
                        finalClusterAssignments,
                        line -> {
                            genMonitor.subTask(line);
                            PluginConsole.println(line);
                        });

                    handleGenerationResult(resultJson, packageName, systemUrl, client,
                        username, password, docProvider, docApiKey, docModel, docBaseUrl,
                        maxTotalTokens, userContext, display, shell);

                    return Status.OK_STATUS;
                } catch (Exception e) {
                    display.asyncExec(() ->
                        MessageDialog.openError(shell, "ABAP Doc Generator",
                            "Failed to generate package documentation: " + e.getMessage()));
                    return Status.error("Package documentation generation failed", e);
                } finally {
                    genMonitor.done();
                }
            }
        };
        genJob.setUser(true);
        genJob.schedule();
    }

    private void handleGenerationResult(String resultJson, String packageName,
                                         String systemUrl, String client, String username, String password,
                                         String docProvider, String docApiKey, String docModel, String docBaseUrl,
                                         int maxTotalTokens, String userContext,
                                         Display display, Shell shell) throws Exception {
        String tokenInfo = extractPackageTokenUsage(resultJson);
        Map<String, String> pages = extractPages(resultJson);

        if (!pages.isEmpty()) {
            File tempDir = Files.createTempDirectory("pkg-doc-" + packageName + "-").toFile();
            for (Map.Entry<String, String> entry : pages.entrySet()) {
                File pageFile = new File(tempDir, entry.getKey());
                pageFile.getParentFile().mkdirs();
                Files.writeString(pageFile.toPath(), entry.getValue(), StandardCharsets.UTF_8);
            }
            PluginConsole.println("HTML wiki written to " + tempDir.getAbsolutePath()
                + " (" + pages.size() + " pages)");

            GenerationResult gr = GenerationResult.getInstance();
            gr.clear();
            gr.setObjectName(packageName);
            gr.setObjectType("PACKAGE");
            gr.setPackage(true);
            gr.setMarkdown(extractDocumentation(resultJson));
            gr.setSinglePageHtml(extractJsonStringField(resultJson, "singlePageHtml"));
            gr.setPages(pages);
            gr.setPagesDirectory(tempDir);
            gr.setSystemUrl(systemUrl);
            gr.setClient(client);
            gr.setUsername(username);
            gr.setPassword(password);
            gr.setDocProvider(docProvider);
            gr.setDocApiKey(docApiKey);
            gr.setDocModel(docModel);
            gr.setDocBaseUrl(docBaseUrl);
            gr.setMaxTotalTokens(maxTotalTokens);
            gr.setUserContext(userContext);

            display.asyncExec(() -> {
                try {
                    IWorkbenchPage page = PlatformUI.getWorkbench()
                        .getActiveWorkbenchWindow().getActivePage();
                    ChatView view = (ChatView) page.showView(ChatView.ID);
                    view.showPackageDoc(tempDir);
                    MessageDialog.openInformation(shell, "ABAP Doc Generator",
                        "Package documentation generated for " + packageName + "\n\n" + tokenInfo);
                } catch (Exception e) {
                    MessageDialog.openError(shell, "ABAP Doc Generator",
                        "Failed to open result: " + e.getMessage());
                }
            });
        } else {
            String documentation = extractDocumentation(resultJson);
            File tempFile = File.createTempFile("pkg-doc-" + packageName + "-", ".md");
            tempFile.deleteOnExit();
            Files.writeString(tempFile.toPath(), documentation, StandardCharsets.UTF_8);

            display.asyncExec(() -> {
                try {
                    org.eclipse.ui.IWorkbenchPage page = PlatformUI.getWorkbench()
                        .getActiveWorkbenchWindow().getActivePage();
                    org.eclipse.ui.ide.IDE.openEditorOnFileStore(page,
                        org.eclipse.core.filesystem.EFS.getLocalFileSystem()
                            .fromLocalFile(tempFile));
                    MessageDialog.openInformation(shell, "ABAP Doc Generator",
                        "Package documentation generated for " + packageName + "\n\n" + tokenInfo);
                } catch (Exception e) {
                    MessageDialog.openError(shell, "ABAP Doc Generator",
                        "Failed to open result: " + e.getMessage());
                }
            });
        }
    }

    private static String extractDocumentation(String json) {
        String key = "\"documentation\":\"";
        int start = json.indexOf(key);
        if (start == -1) return json;
        start += key.length();

        StringBuilder sb = new StringBuilder();
        boolean escaped = false;
        for (int i = start; i < json.length(); i++) {
            char c = json.charAt(i);
            if (escaped) {
                switch (c) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    default: sb.append('\\').append(c);
                }
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == '"') {
                break;
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String extractJsonStringField(String json, String field) {
        String key = "\"" + field + "\":\"";
        int start = json.indexOf(key);
        if (start == -1) return "";
        start += key.length();

        StringBuilder sb = new StringBuilder();
        boolean escaped = false;
        for (int i = start; i < json.length(); i++) {
            char c = json.charAt(i);
            if (escaped) {
                switch (c) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/': sb.append('/'); break;
                    default: sb.append('\\').append(c);
                }
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == '"') {
                break;
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String extractPackageTokenUsage(String json) {
        int summaryTokens = extractIntField(json, "summaryTokens");
        int objectDocTokens = extractIntField(json, "objectDocTokens");
        int clusterSummaryTokens = extractIntField(json, "clusterSummaryTokens");
        int overviewTokens = extractIntField(json, "overviewTokens");
        int totalTokens = extractIntField(json, "totalTokens");
        int objectCount = extractIntField(json, "objectCount");
        int clusterCount = extractIntField(json, "clusterCount");

        StringBuilder sb = new StringBuilder();
        sb.append("Package: ").append(objectCount).append(" objects, ").append(clusterCount).append(" clusters\n\n");
        sb.append("Token Usage:\n");
        sb.append("  Summary tokens: ").append(String.format("%,d", summaryTokens)).append("\n");
        sb.append("  Object doc tokens: ").append(String.format("%,d", objectDocTokens)).append("\n");
        sb.append("  Cluster summary tokens: ").append(String.format("%,d", clusterSummaryTokens)).append("\n");
        sb.append("  Overview tokens: ").append(String.format("%,d", overviewTokens)).append("\n");
        sb.append("  Total tokens: ").append(String.format("%,d", totalTokens));
        return sb.toString();
    }

    private static int extractIntField(String json, String field) {
        String key = "\"" + field + "\":";
        int start = json.indexOf(key);
        if (start == -1) return 0;
        start += key.length();
        StringBuilder digits = new StringBuilder();
        for (int i = start; i < json.length(); i++) {
            char c = json.charAt(i);
            if (Character.isDigit(c)) {
                digits.append(c);
            } else if (digits.length() > 0) {
                break;
            }
        }
        if (digits.length() == 0) return 0;
        try {
            return Integer.parseInt(digits.toString());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * Parses the list-package-objects JSON result into dialog items.
     */
    private static List<ObjectSelectionDialog.PackageObjectItem> parseObjectList(String json) {
        List<ObjectSelectionDialog.PackageObjectItem> items = new ArrayList<>();
        String key = "\"objects\":[";
        int start = json.indexOf(key);
        if (start == -1) return items;
        int pos = start + key.length();

        while (pos < json.length()) {
            int objStart = json.indexOf('{', pos);
            if (objStart == -1) break;
            int objEnd = json.indexOf('}', objStart);
            if (objEnd == -1) break;

            String objJson = json.substring(objStart, objEnd + 1);
            String name = extractSimpleField(objJson, "name");
            String type = extractSimpleField(objJson, "type");
            String description = extractSimpleField(objJson, "description");
            String subPackage = extractSimpleField(objJson, "subPackage");

            if (name != null && !name.isEmpty()) {
                items.add(new ObjectSelectionDialog.PackageObjectItem(name, type, description, subPackage));
            }

            pos = objEnd + 1;
            while (pos < json.length() && (json.charAt(pos) == ',' || Character.isWhitespace(json.charAt(pos)))) {
                pos++;
            }
            if (pos < json.length() && json.charAt(pos) == ']') break;
        }
        return items;
    }

    private static String extractSimpleField(String json, String field) {
        String key = "\"" + field + "\":\"";
        int start = json.indexOf(key);
        if (start == -1) return "";
        start += key.length();

        StringBuilder sb = new StringBuilder();
        boolean escaped = false;
        for (int i = start; i < json.length(); i++) {
            char c = json.charAt(i);
            if (escaped) {
                switch (c) {
                    case 'n': sb.append('\n'); break;
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    default: sb.append(c);
                }
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == '"') {
                break;
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /**
     * Extracts the "pages" object from JSON: {"pages":{"index.html":"<html>...","ZCL_FOO.html":"<html>..."}}
     * Returns a map of filename → HTML content.
     */
    private static Map<String, String> extractPages(String json) {
        Map<String, String> pages = new LinkedHashMap<>();
        String key = "\"pages\":{";
        int start = json.indexOf(key);
        if (start == -1) return pages;
        int pos = start + key.length();

        while (pos < json.length()) {
            // Skip whitespace and commas
            while (pos < json.length() && (Character.isWhitespace(json.charAt(pos)) || json.charAt(pos) == ',')) {
                pos++;
            }
            if (pos >= json.length() || json.charAt(pos) == '}') break;

            // Opening quote for key
            if (json.charAt(pos) != '"') break;
            pos++;

            // Extract filename key (simple string, no escaping needed)
            int keyEnd = json.indexOf('"', pos);
            if (keyEnd == -1) break;
            String filename = json.substring(pos, keyEnd);
            pos = keyEnd + 1;

            // Skip colon and whitespace
            while (pos < json.length() && (json.charAt(pos) == ':' || Character.isWhitespace(json.charAt(pos)))) {
                pos++;
            }

            // Opening quote for value
            if (pos >= json.length() || json.charAt(pos) != '"') break;
            pos++;

            // Extract value with escape handling
            StringBuilder sb = new StringBuilder();
            boolean escaped = false;
            while (pos < json.length()) {
                char c = json.charAt(pos);
                if (escaped) {
                    switch (c) {
                        case 'n': sb.append('\n'); break;
                        case 't': sb.append('\t'); break;
                        case 'r': sb.append('\r'); break;
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        default: sb.append('\\').append(c);
                    }
                    escaped = false;
                } else if (c == '\\') {
                    escaped = true;
                } else if (c == '"') {
                    pos++;
                    break;
                } else {
                    sb.append(c);
                }
                pos++;
            }

            pages.put(filename, sb.toString());
        }

        return pages;
    }

    /**
     * Parses the triage-package JSON result into TriageReviewDialog items.
     * JSON shape: {"objects":[{"name":"...","type":"...","summary":"...","sourceLines":N,"depCount":N,"usedByCount":N,"triageDecision":"full"|"summary","subPackage":"...","clusterName":"..."},...]}
     */
    private static List<TriageReviewDialog.TriageObjectItem> parseTriageResult(String json) {
        List<TriageReviewDialog.TriageObjectItem> items = new ArrayList<>();
        String key = "\"objects\":[";
        int start = json.indexOf(key);
        if (start == -1) return items;
        int pos = start + key.length();

        while (pos < json.length()) {
            int objStart = json.indexOf('{', pos);
            if (objStart == -1) break;
            int objEnd = findMatchingBrace(json, objStart);
            if (objEnd == -1) break;

            String objJson = json.substring(objStart, objEnd + 1);
            String name = extractSimpleField(objJson, "name");
            String type = extractSimpleField(objJson, "type");
            String summary = extractSimpleField(objJson, "summary");
            int sourceLines = extractIntField(objJson, "sourceLines");
            int depCount = extractIntField(objJson, "depCount");
            int usedByCount = extractIntField(objJson, "usedByCount");
            String decision = extractSimpleField(objJson, "triageDecision");
            String subPackage = extractSimpleField(objJson, "subPackage");
            String clusterName = extractSimpleField(objJson, "clusterName");

            if (name != null && !name.isEmpty()) {
                items.add(new TriageReviewDialog.TriageObjectItem(
                    name, type, summary, sourceLines, depCount, usedByCount,
                    "full".equals(decision), subPackage, clusterName));
            }

            pos = objEnd + 1;
            while (pos < json.length() && (json.charAt(pos) == ',' || Character.isWhitespace(json.charAt(pos)))) {
                pos++;
            }
            if (pos < json.length() && json.charAt(pos) == ']') break;
        }
        return items;
    }

    /**
     * Extracts object summaries from triage result: name → summary.
     */
    private static Map<String, String> extractSummariesFromTriage(String json) {
        Map<String, String> summaries = new HashMap<>();
        String key = "\"objects\":[";
        int start = json.indexOf(key);
        if (start == -1) return summaries;
        int pos = start + key.length();

        while (pos < json.length()) {
            int objStart = json.indexOf('{', pos);
            if (objStart == -1) break;
            int objEnd = findMatchingBrace(json, objStart);
            if (objEnd == -1) break;

            String objJson = json.substring(objStart, objEnd + 1);
            String name = extractSimpleField(objJson, "name");
            String summary = extractSimpleField(objJson, "summary");
            if (name != null && !name.isEmpty() && summary != null && !summary.isEmpty()) {
                summaries.put(name, summary);
            }

            pos = objEnd + 1;
            while (pos < json.length() && (json.charAt(pos) == ',' || Character.isWhitespace(json.charAt(pos)))) {
                pos++;
            }
            if (pos < json.length() && json.charAt(pos) == ']') break;
        }
        return summaries;
    }

    /**
     * Extracts cluster summaries from triage result: compositeKey → summary.
     * Uses "subPackage::clusterName" as key to avoid collisions between
     * identically-named clusters (e.g. "Standalone Objects") across packages.
     * Root-level clusters (empty subPackage) use just the cluster name.
     */
    private static Map<String, String> extractClusterSummariesFromTriage(String json) {
        Map<String, String> clusterSummaries = new HashMap<>();
        String key = "\"clusters\":[";
        int start = json.indexOf(key);
        if (start == -1) return clusterSummaries;
        int pos = start + key.length();

        while (pos < json.length()) {
            int objStart = json.indexOf('{', pos);
            if (objStart == -1) break;
            int objEnd = findMatchingBrace(json, objStart);
            if (objEnd == -1) break;

            String objJson = json.substring(objStart, objEnd + 1);
            String name = extractSimpleField(objJson, "name");
            String summary = extractSimpleField(objJson, "summary");
            String subPackage = extractSimpleField(objJson, "subPackage");
            if (name != null && !name.isEmpty()) {
                String compositeKey = (subPackage != null && !subPackage.isEmpty())
                    ? subPackage + "::" + name : name;
                clusterSummaries.put(compositeKey, summary != null ? summary : "");
            }

            pos = objEnd + 1;
            while (pos < json.length() && (json.charAt(pos) == ',' || Character.isWhitespace(json.charAt(pos)))) {
                pos++;
            }
            if (pos < json.length() && json.charAt(pos) == ']') break;
        }
        return clusterSummaries;
    }

    /**
     * Extracts cluster assignments from triage result: compositeKey → objectNames[].
     * Uses "subPackage::clusterName" as key to avoid collisions between
     * identically-named clusters across packages.
     */
    private static Map<String, String[]> extractClusterAssignmentsFromTriage(String json) {
        Map<String, String[]> assignments = new HashMap<>();
        String key = "\"clusters\":[";
        int start = json.indexOf(key);
        if (start == -1) return assignments;
        int pos = start + key.length();

        while (pos < json.length()) {
            int objStart = json.indexOf('{', pos);
            if (objStart == -1) break;
            int objEnd = findMatchingBrace(json, objStart);
            if (objEnd == -1) break;

            String objJson = json.substring(objStart, objEnd + 1);
            String name = extractSimpleField(objJson, "name");
            String[] objectNames = extractStringArray(objJson, "objectNames");
            String subPackage = extractSimpleField(objJson, "subPackage");
            if (name != null && !name.isEmpty() && objectNames.length > 0) {
                String compositeKey = (subPackage != null && !subPackage.isEmpty())
                    ? subPackage + "::" + name : name;
                assignments.put(compositeKey, objectNames);
            }

            pos = objEnd + 1;
            while (pos < json.length() && (json.charAt(pos) == ',' || Character.isWhitespace(json.charAt(pos)))) {
                pos++;
            }
            if (pos < json.length() && json.charAt(pos) == ']') break;
        }
        return assignments;
    }

    /**
     * Finds the matching closing brace for an opening brace, handling nesting.
     */
    private static int findMatchingBrace(String json, int openPos) {
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = openPos; i < json.length(); i++) {
            char c = json.charAt(i);
            if (escaped) {
                escaped = false;
                continue;
            }
            if (c == '\\' && inString) {
                escaped = true;
                continue;
            }
            if (c == '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) return i;
            }
        }
        return -1;
    }

    /**
     * Extracts a JSON string array field value, e.g. "objectNames":["A","B","C"].
     */
    private static String[] extractStringArray(String json, String field) {
        String key = "\"" + field + "\":[";
        int start = json.indexOf(key);
        if (start == -1) return new String[0];
        int pos = start + key.length();

        List<String> result = new ArrayList<>();
        while (pos < json.length()) {
            while (pos < json.length() && (Character.isWhitespace(json.charAt(pos)) || json.charAt(pos) == ',')) {
                pos++;
            }
            if (pos >= json.length() || json.charAt(pos) == ']') break;
            if (json.charAt(pos) != '"') break;
            pos++; // skip opening quote

            StringBuilder sb = new StringBuilder();
            boolean esc = false;
            while (pos < json.length()) {
                char c = json.charAt(pos);
                if (esc) {
                    switch (c) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case 'n': sb.append('\n'); break;
                        default: sb.append(c);
                    }
                    esc = false;
                } else if (c == '\\') {
                    esc = true;
                } else if (c == '"') {
                    pos++;
                    break;
                } else {
                    sb.append(c);
                }
                pos++;
            }
            result.add(sb.toString());
        }
        return result.toArray(new String[0]);
    }

    /**
     * Extracts named cluster names (excluding "Standalone Objects") from precomputed assignments.
     * Also populates the clusterInfos list for the reassignment dialog.
     */
    private static String[] extractNamedClusters(
            Map<String, String[]> clusterAssignments,
            Map<String, String> clusterSummaries,
            List<StandaloneReassignDialog.ClusterInfo> clusterInfos) {
        if (clusterAssignments == null) return new String[0];
        List<String> names = new ArrayList<>();
        for (String key : clusterAssignments.keySet()) {
            String clusterName = key.contains("::") ? key.substring(key.indexOf("::") + 2) : key;
            if (!"Standalone Objects".equals(clusterName)) {
                if (!names.contains(clusterName)) {
                    names.add(clusterName);
                    String summary = "";
                    if (clusterSummaries != null) {
                        summary = clusterSummaries.getOrDefault(key, clusterSummaries.getOrDefault(clusterName, ""));
                    }
                    clusterInfos.add(new StandaloneReassignDialog.ClusterInfo(clusterName, summary));
                }
            }
        }
        return names.toArray(new String[0]);
    }

    /**
     * Applies standalone object reassignments to the cluster assignments map.
     * Moves objects from "Standalone Objects" clusters to their assigned target clusters.
     */
    private static Map<String, String[]> applyReassignments(
            Map<String, String[]> original,
            Map<String, String> reassignments) {
        if (original == null || reassignments.isEmpty()) return original;

        Map<String, List<String>> mutable = new LinkedHashMap<>();
        for (Map.Entry<String, String[]> entry : original.entrySet()) {
            List<String> list = new ArrayList<>();
            for (String name : entry.getValue()) {
                list.add(name);
            }
            mutable.put(entry.getKey(), list);
        }

        for (Map.Entry<String, String> reassignment : reassignments.entrySet()) {
            String objName = reassignment.getKey();
            String targetCluster = reassignment.getValue();

            // Remove from Standalone Objects
            for (Map.Entry<String, List<String>> entry : mutable.entrySet()) {
                String key = entry.getKey();
                String clusterName = key.contains("::") ? key.substring(key.indexOf("::") + 2) : key;
                if ("Standalone Objects".equals(clusterName)) {
                    entry.getValue().remove(objName);
                }
            }

            // Add to target cluster (find matching key)
            boolean added = false;
            for (Map.Entry<String, List<String>> entry : mutable.entrySet()) {
                String key = entry.getKey();
                String clusterName = key.contains("::") ? key.substring(key.indexOf("::") + 2) : key;
                if (clusterName.equals(targetCluster)) {
                    entry.getValue().add(objName);
                    added = true;
                    break;
                }
            }
            if (!added) {
                // Target cluster not found — put it back in standalone
                for (Map.Entry<String, List<String>> entry : mutable.entrySet()) {
                    String key = entry.getKey();
                    String clusterName = key.contains("::") ? key.substring(key.indexOf("::") + 2) : key;
                    if ("Standalone Objects".equals(clusterName)) {
                        entry.getValue().add(objName);
                        break;
                    }
                }
            }
        }

        // Convert back to Map<String, String[]>, removing empty clusters
        Map<String, String[]> result = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> entry : mutable.entrySet()) {
            if (!entry.getValue().isEmpty()) {
                result.put(entry.getKey(), entry.getValue().toArray(new String[0]));
            }
        }
        return result;
    }
}
