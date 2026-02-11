package com.abap.doc.plugin.handler;

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
import org.eclipse.ui.handlers.HandlerUtil;

import com.abap.doc.plugin.Activator;
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

        // Get object name from the active editor title
        // ADT editor titles look like "[SYS] ZCL_MY_CLASS" — strip the system prefix
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

        Job job = new Job("Building dependency graph for " + objectName) {
            @Override
            protected IStatus run(IProgressMonitor monitor) {
                monitor.beginTask("Building dependency graph for " + fObjectName, IProgressMonitor.UNKNOWN);
                try {
                    DagRunner runner = new DagRunner();
                    String resultJson = runner.buildDag(systemUrl, client, username, password,
                        fObjectName, fObjectType,
                        line -> monitor.subTask(line));

                    String preview = resultJson.length() > 3000
                        ? resultJson.substring(0, 3000) + "\n\n... (truncated)"
                        : resultJson;

                    display.asyncExec(() ->
                        MessageDialog.openInformation(shell,
                            "Dependency Graph — " + fObjectName, preview));

                    return Status.OK_STATUS;
                } catch (Exception e) {
                    display.asyncExec(() ->
                        MessageDialog.openError(shell, "ABAP Doc Generator",
                            "Failed to build dependency graph: " + e.getMessage()));
                    return Status.error("DAG build failed", e);
                } finally {
                    monitor.done();
                }
            }
        };
        job.setUser(true);
        job.schedule();

        return null;
    }
}
