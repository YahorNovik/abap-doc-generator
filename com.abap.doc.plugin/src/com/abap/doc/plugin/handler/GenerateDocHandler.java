package com.abap.doc.plugin.handler;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.commands.ExecutionException;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Status;
import org.eclipse.core.runtime.jobs.Job;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.jface.preference.IPreferenceStore;
import org.eclipse.swt.widgets.Display;
import org.eclipse.swt.widgets.Shell;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.PlatformUI;
import org.eclipse.ui.handlers.HandlerUtil;
import org.eclipse.ui.ide.IDE;

import com.abap.doc.plugin.Activator;
import com.abap.doc.plugin.PluginConsole;
import com.abap.doc.plugin.dag.DagRunner;
import com.abap.doc.plugin.preferences.ConnectionPreferencePage;

public class GenerateDocHandler extends AbstractHandler {

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

        // Processing mode
        String mode = store.getString(ConnectionPreferencePage.PREF_MODE);
        if (mode == null || mode.isBlank()) {
            mode = "realtime";
        }

        // Token budget
        int maxTotalTokens = store.getInt(ConnectionPreferencePage.PREF_MAX_TOKENS);

        // Documentation template
        String templateType = store.getString(ConnectionPreferencePage.PREF_TEMPLATE);
        String templateCustom = store.getString(ConnectionPreferencePage.PREF_TEMPLATE_CUSTOM);

        if (summaryApiKey.isBlank() || summaryModel.isBlank() || docApiKey.isBlank() || docModel.isBlank()) {
            MessageDialog.openError(shell, "ABAP Doc Generator",
                "Please configure LLM settings in Preferences > ABAP Doc Generator");
            return null;
        }

        // Get object name from the active editor title
        String objectName = null;
        IEditorPart editor = HandlerUtil.getActiveEditor(event);
        if (editor != null) {
            objectName = editor.getTitle();
            if (objectName != null) {
                objectName = objectName.replaceAll("^\\[.*?\\]\\s*", "").trim().toUpperCase();
            }
        }

        if (objectName == null || objectName.isEmpty()) {
            MessageDialog.openError(shell, "ABAP Doc Generator",
                "Please open an ABAP object in the editor first.");
            return null;
        }

        // Determine object type from name
        String objectType = "CLAS";
        if (objectName.startsWith("ZIF_") || objectName.startsWith("YIF_")
            || objectName.startsWith("IF_")) {
            objectType = "INTF";
        }

        final String fObjectName = objectName;
        final String fObjectType = objectType;
        final String fMode = mode;
        final int fMaxTotalTokens = maxTotalTokens;
        final String fTemplateType = templateType;
        final String fTemplateCustom = templateCustom;

        Job job = new Job("Generating documentation for " + objectName) {
            @Override
            protected IStatus run(IProgressMonitor monitor) {
                monitor.beginTask("Generating documentation for " + fObjectName, IProgressMonitor.UNKNOWN);
                PluginConsole.clear();
                PluginConsole.show();
                PluginConsole.println("Generating documentation for " + fObjectName + " (" + fObjectType + ")");
                try {
                    DagRunner runner = new DagRunner();
                    String resultJson = runner.generateDoc(
                        systemUrl, client, username, password,
                        fObjectName, fObjectType,
                        summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl,
                        docProvider, docApiKey, docModel, docBaseUrl,
                        fMode, fMaxTotalTokens,
                        fTemplateType, fTemplateCustom,
                        line -> {
                            monitor.subTask(line);
                            PluginConsole.println(line);
                        });

                    // Extract documentation field from JSON result
                    String documentation = extractDocumentation(resultJson);

                    // Extract token usage for display
                    String tokenInfo = extractTokenUsage(resultJson);

                    // Write Markdown to temp file and open in editor
                    File tempFile = File.createTempFile("doc-" + fObjectName + "-", ".md");
                    tempFile.deleteOnExit();
                    Files.writeString(tempFile.toPath(), documentation, StandardCharsets.UTF_8);

                    display.asyncExec(() -> {
                        try {
                            IWorkbenchPage page = PlatformUI.getWorkbench()
                                .getActiveWorkbenchWindow().getActivePage();
                            IDE.openEditorOnFileStore(page,
                                org.eclipse.core.filesystem.EFS.getLocalFileSystem()
                                    .fromLocalFile(tempFile));
                            // Show token usage info
                            MessageDialog.openInformation(shell, "ABAP Doc Generator",
                                "Documentation generated for " + fObjectName + "\n\n" + tokenInfo);
                        } catch (Exception e) {
                            MessageDialog.openError(shell, "ABAP Doc Generator",
                                "Failed to open result: " + e.getMessage());
                        }
                    });

                    return Status.OK_STATUS;
                } catch (Exception e) {
                    display.asyncExec(() ->
                        MessageDialog.openError(shell, "ABAP Doc Generator",
                            "Failed to generate documentation: " + e.getMessage()));
                    return Status.error("Documentation generation failed", e);
                } finally {
                    monitor.done();
                }
            }
        };
        job.setUser(true);
        job.schedule();

        return null;
    }

    /**
     * Extracts the "documentation" field from the JSON result.
     * Simple extraction without a JSON library.
     */
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

    /**
     * Extracts token usage summary from the JSON result.
     */
    private static String extractTokenUsage(String json) {
        int summaryTokens = extractIntField(json, "summaryTokens");
        int docTokens = extractIntField(json, "docTokens");
        int totalTokens = extractIntField(json, "totalTokens");
        int agentIterations = extractIntField(json, "agentIterations");
        int toolCalls = extractIntField(json, "toolCalls");

        StringBuilder sb = new StringBuilder();
        sb.append("Token Usage:\n");
        sb.append("  Summary tokens: ").append(String.format("%,d", summaryTokens)).append("\n");
        sb.append("  Doc tokens: ").append(String.format("%,d", docTokens)).append("\n");
        sb.append("  Total tokens: ").append(String.format("%,d", totalTokens)).append("\n");
        if (agentIterations > 0) {
            sb.append("  Agent iterations: ").append(agentIterations).append("\n");
        }
        if (toolCalls > 0) {
            sb.append("  Tool calls: ").append(toolCalls);
        }
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
}
