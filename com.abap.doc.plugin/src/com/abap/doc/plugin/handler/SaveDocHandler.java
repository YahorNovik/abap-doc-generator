package com.abap.doc.plugin.handler;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.commands.ExecutionException;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.jface.preference.IPreferenceStore;
import org.eclipse.swt.SWT;
import org.eclipse.swt.widgets.DirectoryDialog;
import org.eclipse.swt.widgets.Shell;
import org.eclipse.ui.handlers.HandlerUtil;

import com.abap.doc.plugin.Activator;
import com.abap.doc.plugin.GenerationResult;
import com.abap.doc.plugin.PluginConsole;
import com.abap.doc.plugin.preferences.ConnectionPreferencePage;

public class SaveDocHandler extends AbstractHandler {

    @Override
    public Object execute(ExecutionEvent event) throws ExecutionException {
        Shell shell = HandlerUtil.getActiveShell(event);
        GenerationResult gr = GenerationResult.getInstance();

        if (!gr.hasResult()) {
            MessageDialog.openError(shell, "ABAP Doc Generator",
                "No documentation to save. Generate documentation first.");
            return null;
        }

        IPreferenceStore store = Activator.getDefault().getPreferenceStore();
        String defaultPath = store.getString(ConnectionPreferencePage.PREF_SAVE_PATH);

        DirectoryDialog dirDialog = new DirectoryDialog(shell, SWT.SAVE);
        dirDialog.setText("Save Documentation");
        dirDialog.setMessage("Choose a directory to save the documentation.");
        if (defaultPath != null && !defaultPath.isBlank()) {
            dirDialog.setFilterPath(defaultPath);
        }

        String selectedPath = dirDialog.open();
        if (selectedPath == null) {
            return null;
        }

        try {
            File targetDir = new File(selectedPath);
            if (!targetDir.exists()) {
                targetDir.mkdirs();
            }

            if (gr.isPackage() && gr.getPages() != null) {
                for (Map.Entry<String, String> entry : gr.getPages().entrySet()) {
                    File pageFile = new File(targetDir, entry.getKey());
                    Files.writeString(pageFile.toPath(), entry.getValue(), StandardCharsets.UTF_8);
                }
                PluginConsole.println("Saved " + gr.getPages().size() + " pages to " + selectedPath);
                MessageDialog.openInformation(shell, "ABAP Doc Generator",
                    "Package documentation saved to:\n" + selectedPath
                    + "\n(" + gr.getPages().size() + " files)");
            } else if (gr.getHtml() != null) {
                String fileName = gr.getObjectName() + ".html";
                File outFile = new File(targetDir, fileName);
                Files.writeString(outFile.toPath(), gr.getHtml(), StandardCharsets.UTF_8);
                PluginConsole.println("Saved documentation to " + outFile.getAbsolutePath());
                MessageDialog.openInformation(shell, "ABAP Doc Generator",
                    "Documentation saved to:\n" + outFile.getAbsolutePath());
            }
        } catch (Exception e) {
            MessageDialog.openError(shell, "ABAP Doc Generator",
                "Failed to save documentation: " + e.getMessage());
        }

        return null;
    }
}
