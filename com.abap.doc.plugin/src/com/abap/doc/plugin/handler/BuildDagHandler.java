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
import org.eclipse.jface.dialogs.InputDialog;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.jface.preference.IPreferenceStore;
import org.eclipse.jface.window.Window;
import org.eclipse.swt.widgets.Display;
import org.eclipse.swt.widgets.Shell;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.PlatformUI;
import org.eclipse.ui.handlers.HandlerUtil;

import com.abap.doc.plugin.Activator;
import com.abap.doc.plugin.PluginConsole;
import com.abap.doc.plugin.chat.ChatView;
import com.abap.doc.plugin.dag.DagRunner;
import com.abap.doc.plugin.preferences.ConnectionPreferencePage;

public class BuildDagHandler extends AbstractHandler {

    @Override
    public Object execute(ExecutionEvent event) throws ExecutionException {
        Shell shell = HandlerUtil.getActiveShell(event);
        Display display = shell.getDisplay();
        IPreferenceStore store = Activator.getDefault().getPreferenceStore();

        String systemUrl = store.getString(ConnectionPreferencePage.PREF_SYSTEM_URL);
        String client = store.getString(ConnectionPreferencePage.PREF_CLIENT);
        String username = store.getString(ConnectionPreferencePage.PREF_USERNAME);
        String password = store.getString(ConnectionPreferencePage.PREF_PASSWORD);

        if (systemUrl.isBlank() || username.isBlank()) {
            MessageDialog.openError(shell, "ABAP Doc Generator",
                "Please configure SAP connection in Preferences > ABAP Doc Generator");
            return null;
        }

        // Ask user for mode: Current Object or Package
        String[] options = { "Current Object", "Package", "Cancel" };
        MessageDialog modeDialog = new MessageDialog(shell,
            "Show Dependency Diagram", null,
            "Show dependency diagram for the current editor object or for an entire package?",
            MessageDialog.QUESTION, options, 0);
        int choice = modeDialog.open();

        if (choice == 2 || choice == -1) {
            return null; // Cancel
        }

        if (choice == 0) {
            // Current Object mode
            return handleObjectMode(event, shell, display, systemUrl, client, username, password);
        } else {
            // Package mode
            return handlePackageMode(shell, display, store, systemUrl, client, username, password);
        }
    }

    private Object handleObjectMode(ExecutionEvent event, Shell shell, Display display,
                                     String systemUrl, String client, String username, String password) {
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

        String objectType = "CLAS";
        if (objectName.startsWith("ZIF_") || objectName.startsWith("YIF_")
            || objectName.startsWith("IF_")) {
            objectType = "INTF";
        }

        final String fObjectName = objectName;
        final String fObjectType = objectType;

        Job job = new Job("Building dependency diagram for " + objectName) {
            @Override
            protected IStatus run(IProgressMonitor monitor) {
                monitor.beginTask("Building dependency diagram for " + fObjectName, IProgressMonitor.UNKNOWN);
                PluginConsole.clear();
                PluginConsole.show();
                PluginConsole.println("Building dependency diagram for " + fObjectName + " (" + fObjectType + ")");
                try {
                    DagRunner runner = new DagRunner();
                    String resultJson = runner.renderDiagram(systemUrl, client, username, password,
                        fObjectName, fObjectType,
                        line -> {
                            monitor.subTask(line);
                            PluginConsole.println(line);
                        });

                    String html = extractHtmlField(resultJson);
                    if (html == null) {
                        throw new Exception("No HTML returned from diagram builder");
                    }

                    // Write HTML to temp file for reference
                    File tempFile = File.createTempFile("diagram-" + fObjectName + "-", ".html");
                    tempFile.deleteOnExit();
                    Files.writeString(tempFile.toPath(), html, StandardCharsets.UTF_8);
                    PluginConsole.println("Diagram HTML written to " + tempFile.getAbsolutePath());

                    display.asyncExec(() -> {
                        try {
                            IWorkbenchPage page = PlatformUI.getWorkbench()
                                .getActiveWorkbenchWindow().getActivePage();
                            ChatView view = (ChatView) page.showView(ChatView.ID);
                            view.showHtml(html);
                        } catch (Exception e) {
                            MessageDialog.openError(shell, "ABAP Doc Generator",
                                "Failed to display diagram: " + e.getMessage());
                        }
                    });

                    return Status.OK_STATUS;
                } catch (Exception e) {
                    display.asyncExec(() ->
                        MessageDialog.openError(shell, "ABAP Doc Generator",
                            "Failed to build dependency diagram: " + e.getMessage()));
                    return Status.error("Diagram build failed", e);
                } finally {
                    monitor.done();
                }
            }
        };
        job.setUser(true);
        job.schedule();
        return null;
    }

    private Object handlePackageMode(Shell shell, Display display, IPreferenceStore store,
                                      String systemUrl, String client, String username, String password) {
        InputDialog dlg = new InputDialog(shell, "Package Dependency Diagram",
            "Enter the ABAP package name:", "", null);
        if (dlg.open() != Window.OK) {
            return null;
        }
        String packageName = dlg.getValue().trim().toUpperCase();
        if (packageName.isEmpty()) {
            return null;
        }

        int maxSubPackageDepth = store.getInt(ConnectionPreferencePage.PREF_MAX_SUBPACKAGE_DEPTH);

        Job job = new Job("Building dependency diagram for package " + packageName) {
            @Override
            protected IStatus run(IProgressMonitor monitor) {
                monitor.beginTask("Building dependency diagram for " + packageName, IProgressMonitor.UNKNOWN);
                PluginConsole.clear();
                PluginConsole.show();
                PluginConsole.println("Building dependency diagram for package " + packageName);
                try {
                    DagRunner runner = new DagRunner();
                    String resultJson = runner.renderPackageDiagram(systemUrl, client, username, password,
                        packageName, maxSubPackageDepth,
                        line -> {
                            monitor.subTask(line);
                            PluginConsole.println(line);
                        });

                    String html = extractHtmlField(resultJson);
                    if (html == null) {
                        throw new Exception("No HTML returned from diagram builder");
                    }

                    // Write HTML to temp file for reference
                    File tempFile = File.createTempFile("diagram-" + packageName + "-", ".html");
                    tempFile.deleteOnExit();
                    Files.writeString(tempFile.toPath(), html, StandardCharsets.UTF_8);
                    PluginConsole.println("Diagram HTML written to " + tempFile.getAbsolutePath());

                    display.asyncExec(() -> {
                        try {
                            IWorkbenchPage page = PlatformUI.getWorkbench()
                                .getActiveWorkbenchWindow().getActivePage();
                            ChatView view = (ChatView) page.showView(ChatView.ID);
                            view.showHtml(html);
                        } catch (Exception e) {
                            MessageDialog.openError(shell, "ABAP Doc Generator",
                                "Failed to display diagram: " + e.getMessage());
                        }
                    });

                    return Status.OK_STATUS;
                } catch (Exception e) {
                    display.asyncExec(() ->
                        MessageDialog.openError(shell, "ABAP Doc Generator",
                            "Failed to build package diagram: " + e.getMessage()));
                    return Status.error("Package diagram build failed", e);
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
     * Extracts the "html" field from the JSON result.
     */
    private static String extractHtmlField(String json) {
        String key = "\"html\":\"";
        int start = json.indexOf(key);
        if (start == -1) return null;
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
}
