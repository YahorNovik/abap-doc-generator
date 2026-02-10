package com.abap.doc.plugin.handler;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.commands.ExecutionException;
import org.eclipse.jface.dialogs.InputDialog;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.jface.preference.IPreferenceStore;
import org.eclipse.jface.window.Window;
import org.eclipse.swt.widgets.Shell;
import org.eclipse.ui.handlers.HandlerUtil;

import com.abap.doc.plugin.Activator;
import com.abap.doc.plugin.dag.DagRunner;
import com.abap.doc.plugin.preferences.ConnectionPreferencePage;

public class BuildDagHandler extends AbstractHandler {

    @Override
    public Object execute(ExecutionEvent event) throws ExecutionException {
        Shell shell = HandlerUtil.getActiveShell(event);
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

        // Prompt for object name
        InputDialog dialog = new InputDialog(shell, "ABAP Doc Generator",
            "Enter ABAP object name (e.g., ZCL_MY_CLASS):", "", null);
        if (dialog.open() != Window.OK) {
            return null;
        }
        String objectName = dialog.getValue().trim().toUpperCase();
        if (objectName.isEmpty()) return null;

        // Default to CLAS, could be extended with a type selector
        String objectType = "CLAS";
        if (objectName.startsWith("ZIF_") || objectName.startsWith("YIF_")
            || objectName.startsWith("IF_")) {
            objectType = "INTF";
        }

        try {
            DagRunner runner = new DagRunner();
            String resultJson = runner.buildDag(systemUrl, client, username, password, objectName, objectType);

            // Show result in a dialog (temporary until HTML preview is built)
            String preview = resultJson.length() > 3000
                ? resultJson.substring(0, 3000) + "\n\n... (truncated)"
                : resultJson;

            MessageDialog.openInformation(shell, "Dependency Graph — " + objectName, preview);
        } catch (Exception e) {
            MessageDialog.openError(shell, "ABAP Doc Generator",
                "Failed to build dependency graph: " + e.getMessage());
        }

        return null;
    }
}
