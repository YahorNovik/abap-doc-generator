package com.abap.doc.plugin.handler;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import java.util.Map;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.commands.ExecutionException;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Status;
import org.eclipse.core.runtime.jobs.Job;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.jface.preference.IPreferenceStore;
import org.eclipse.swt.SWT;
import org.eclipse.swt.widgets.DirectoryDialog;
import org.eclipse.swt.widgets.FileDialog;
import org.eclipse.swt.widgets.Shell;
import org.eclipse.ui.handlers.HandlerUtil;

import com.abap.doc.plugin.Activator;
import com.abap.doc.plugin.GenerationResult;
import com.abap.doc.plugin.PluginConsole;
import com.abap.doc.plugin.dag.DagRunner;
import com.abap.doc.plugin.preferences.ConnectionPreferencePage;

public class SaveDocHandler extends AbstractHandler {

    @Override
    public Object execute(ExecutionEvent event) throws ExecutionException {
        Shell shell = HandlerUtil.getActiveShell(event);
        performSave(shell);
        return null;
    }

    public static void performSave(Shell shell) {
        GenerationResult gr = GenerationResult.getInstance();

        if (!gr.hasResult()) {
            MessageDialog.openError(shell, "ABAP Doc Generator",
                "No documentation to save. Generate documentation first.");
            return;
        }

        // Build format options based on doc type
        String[] options;
        if (gr.isPackage()) {
            options = new String[] { "HTML Wiki (multiple files)", "Single HTML File",
                "Markdown File", "PDF File", "Word Document" };
        } else {
            options = new String[] { "Single HTML File", "Markdown File",
                "PDF File", "Word Document" };
        }

        MessageDialog dialog = new MessageDialog(shell, "Save Documentation", null,
            "Choose export format for: " + gr.getObjectName(),
            MessageDialog.QUESTION, options, 0);
        int choice = dialog.open();
        if (choice < 0) return;

        String selected = options[choice];

        try {
            switch (selected) {
                case "HTML Wiki (multiple files)":
                    saveHtmlWiki(shell, gr);
                    break;
                case "Single HTML File":
                    saveSingleHtml(shell, gr);
                    break;
                case "Markdown File":
                    saveMarkdown(shell, gr);
                    break;
                case "PDF File":
                    saveAsPdf(shell, gr);
                    break;
                case "Word Document":
                    saveAsDocx(shell, gr);
                    break;
            }
        } catch (Exception e) {
            MessageDialog.openError(shell, "ABAP Doc Generator",
                "Failed to save documentation: " + e.getMessage());
        }
    }

    private static void saveHtmlWiki(Shell shell, GenerationResult gr) throws Exception {
        if (!gr.isPackage() || gr.getPages() == null) return;

        String selectedPath = openDirectoryDialog(shell);
        if (selectedPath == null) return;

        File targetDir = new File(selectedPath);
        if (!targetDir.exists()) targetDir.mkdirs();

        for (Map.Entry<String, String> entry : gr.getPages().entrySet()) {
            File pageFile = new File(targetDir, entry.getKey());
            // Ensure parent directories exist (for sub-package subdirectories)
            pageFile.getParentFile().mkdirs();
            Files.writeString(pageFile.toPath(), entry.getValue(), StandardCharsets.UTF_8);
        }

        PluginConsole.println("Saved " + gr.getPages().size() + " pages to " + selectedPath);
        MessageDialog.openInformation(shell, "ABAP Doc Generator",
            "Package documentation saved to:\n" + selectedPath
            + "\n(" + gr.getPages().size() + " files)");
    }

    private static void saveSingleHtml(Shell shell, GenerationResult gr) throws Exception {
        String html;
        if (gr.isPackage() && gr.getSinglePageHtml() != null) {
            html = gr.getSinglePageHtml();
        } else if (gr.getHtml() != null) {
            html = gr.getHtml();
        } else {
            MessageDialog.openError(shell, "ABAP Doc Generator", "No HTML content available.");
            return;
        }

        FileDialog fd = new FileDialog(shell, SWT.SAVE);
        fd.setText("Save as HTML");
        fd.setFilterExtensions(new String[] { "*.html" });
        fd.setFileName(gr.getObjectName() + ".html");
        applyDefaultPath(fd);
        String path = fd.open();
        if (path == null) return;

        Files.writeString(new File(path).toPath(), html, StandardCharsets.UTF_8);
        PluginConsole.println("Saved HTML to " + path);
        MessageDialog.openInformation(shell, "ABAP Doc Generator",
            "Documentation saved to:\n" + path);
    }

    private static void saveMarkdown(Shell shell, GenerationResult gr) throws Exception {
        String md = gr.getMarkdown();
        if (md == null || md.isBlank()) {
            MessageDialog.openError(shell, "ABAP Doc Generator", "No Markdown content available.");
            return;
        }

        FileDialog fd = new FileDialog(shell, SWT.SAVE);
        fd.setText("Save as Markdown");
        fd.setFilterExtensions(new String[] { "*.md" });
        fd.setFileName(gr.getObjectName() + ".md");
        applyDefaultPath(fd);
        String path = fd.open();
        if (path == null) return;

        Files.writeString(new File(path).toPath(), md, StandardCharsets.UTF_8);
        PluginConsole.println("Saved Markdown to " + path);
        MessageDialog.openInformation(shell, "ABAP Doc Generator",
            "Documentation saved to:\n" + path);
    }

    private static void saveAsPdf(Shell shell, GenerationResult gr) {
        String md = gr.getMarkdown();
        if (md == null || md.isBlank()) {
            MessageDialog.openError(shell, "ABAP Doc Generator", "No Markdown content available for PDF export.");
            return;
        }

        FileDialog fd = new FileDialog(shell, SWT.SAVE);
        fd.setText("Save as PDF");
        fd.setFilterExtensions(new String[] { "*.pdf" });
        fd.setFileName(gr.getObjectName() + ".pdf");
        applyDefaultPath(fd);
        String path = fd.open();
        if (path == null) return;

        String title = gr.isPackage()
            ? "Package " + gr.getObjectName()
            : gr.getObjectName();

        final String filePath = path;
        Job job = new Job("Exporting PDF...") {
            @Override
            protected IStatus run(IProgressMonitor monitor) {
                try {
                    DagRunner runner = new DagRunner();
                    String json = runner.exportPdf(md, title, msg -> PluginConsole.println(msg));
                    byte[] pdfBytes = extractBase64Data(json);
                    Files.write(new File(filePath).toPath(), pdfBytes);

                    shell.getDisplay().asyncExec(() -> {
                        PluginConsole.println("Saved PDF to " + filePath);
                        MessageDialog.openInformation(shell, "ABAP Doc Generator",
                            "PDF saved to:\n" + filePath);
                    });
                    return Status.OK_STATUS;
                } catch (Exception e) {
                    shell.getDisplay().asyncExec(() ->
                        MessageDialog.openError(shell, "ABAP Doc Generator",
                            "Failed to export PDF: " + e.getMessage()));
                    return Status.CANCEL_STATUS;
                }
            }
        };
        job.setUser(true);
        job.schedule();
    }

    private static void saveAsDocx(Shell shell, GenerationResult gr) {
        String md = gr.getMarkdown();
        if (md == null || md.isBlank()) {
            MessageDialog.openError(shell, "ABAP Doc Generator", "No Markdown content available for DOCX export.");
            return;
        }

        FileDialog fd = new FileDialog(shell, SWT.SAVE);
        fd.setText("Save as Word Document");
        fd.setFilterExtensions(new String[] { "*.docx" });
        fd.setFileName(gr.getObjectName() + ".docx");
        applyDefaultPath(fd);
        String path = fd.open();
        if (path == null) return;

        String title = gr.isPackage()
            ? "Package " + gr.getObjectName()
            : gr.getObjectName();

        final String filePath = path;
        Job job = new Job("Exporting Word Document...") {
            @Override
            protected IStatus run(IProgressMonitor monitor) {
                try {
                    DagRunner runner = new DagRunner();
                    String json = runner.exportDocx(md, title, msg -> PluginConsole.println(msg));
                    byte[] docxBytes = extractBase64Data(json);
                    Files.write(new File(filePath).toPath(), docxBytes);

                    shell.getDisplay().asyncExec(() -> {
                        PluginConsole.println("Saved Word document to " + filePath);
                        MessageDialog.openInformation(shell, "ABAP Doc Generator",
                            "Word document saved to:\n" + filePath);
                    });
                    return Status.OK_STATUS;
                } catch (Exception e) {
                    shell.getDisplay().asyncExec(() ->
                        MessageDialog.openError(shell, "ABAP Doc Generator",
                            "Failed to export Word document: " + e.getMessage()));
                    return Status.CANCEL_STATUS;
                }
            }
        };
        job.setUser(true);
        job.schedule();
    }

    private static byte[] extractBase64Data(String json) throws Exception {
        // Extract the "data":"..." field from JSON response
        int dataIdx = json.indexOf("\"data\"");
        if (dataIdx == -1) {
            throw new Exception("No data field in export response");
        }
        int colonIdx = json.indexOf(":", dataIdx);
        int startQuote = json.indexOf("\"", colonIdx + 1);
        int endQuote = json.indexOf("\"", startQuote + 1);
        if (startQuote == -1 || endQuote == -1) {
            throw new Exception("Malformed data field in export response");
        }
        String base64 = json.substring(startQuote + 1, endQuote);
        return Base64.getDecoder().decode(base64);
    }

    private static String openDirectoryDialog(Shell shell) {
        IPreferenceStore store = Activator.getDefault().getPreferenceStore();
        String defaultPath = store.getString(ConnectionPreferencePage.PREF_SAVE_PATH);

        DirectoryDialog dirDialog = new DirectoryDialog(shell, SWT.SAVE);
        dirDialog.setText("Save Documentation");
        dirDialog.setMessage("Choose a directory to save the documentation.");
        if (defaultPath != null && !defaultPath.isBlank()) {
            dirDialog.setFilterPath(defaultPath);
        }
        return dirDialog.open();
    }

    private static void applyDefaultPath(FileDialog fd) {
        IPreferenceStore store = Activator.getDefault().getPreferenceStore();
        String defaultPath = store.getString(ConnectionPreferencePage.PREF_SAVE_PATH);
        if (defaultPath != null && !defaultPath.isBlank()) {
            fd.setFilterPath(defaultPath);
        }
    }
}
