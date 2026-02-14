package com.abap.doc.plugin.handler;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
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

        Job job = new Job("Generating package documentation for " + packageName) {
            @Override
            protected IStatus run(IProgressMonitor monitor) {
                monitor.beginTask("Generating package documentation for " + packageName, IProgressMonitor.UNKNOWN);
                PluginConsole.clear();
                PluginConsole.show();
                PluginConsole.println("Generating package documentation for " + packageName);
                try {
                    DagRunner runner = new DagRunner();
                    String resultJson = runner.generatePackageDoc(
                        systemUrl, client, username, password,
                        packageName,
                        summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl,
                        docProvider, docApiKey, docModel, docBaseUrl,
                        fMaxTotalTokens,
                        fTemplateType, fTemplateCustom,
                        fUserContext,
                        fMaxSubPackageDepth,
                        line -> {
                            monitor.subTask(line);
                            PluginConsole.println(line);
                        });

                    // Extract token usage for display
                    String tokenInfo = extractPackageTokenUsage(resultJson);

                    // Extract multi-page HTML wiki
                    Map<String, String> pages = extractPages(resultJson);

                    if (!pages.isEmpty()) {
                        // Write pages to temp directory and open in browser
                        File tempDir = Files.createTempDirectory("pkg-doc-" + packageName + "-").toFile();
                        for (Map.Entry<String, String> entry : pages.entrySet()) {
                            File pageFile = new File(tempDir, entry.getKey());
                            // Ensure parent directories exist (for sub-package subdirectories)
                            pageFile.getParentFile().mkdirs();
                            Files.writeString(pageFile.toPath(), entry.getValue(), StandardCharsets.UTF_8);
                        }
                        PluginConsole.println("HTML wiki written to " + tempDir.getAbsolutePath()
                            + " (" + pages.size() + " pages)");

                        // Store result for chat and save features
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
                        gr.setMaxTotalTokens(fMaxTotalTokens);
                        gr.setUserContext(fUserContext);

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
                        // Fallback: open markdown in editor
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

                    return Status.OK_STATUS;
                } catch (Exception e) {
                    display.asyncExec(() ->
                        MessageDialog.openError(shell, "ABAP Doc Generator",
                            "Failed to generate package documentation: " + e.getMessage()));
                    return Status.error("Package documentation generation failed", e);
                } finally {
                    monitor.done();
                }
            }
        };
        job.setUser(true);
        job.schedule();

        return null;
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
}
