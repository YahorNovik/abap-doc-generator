package com.abap.doc.plugin.chat;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Status;
import org.eclipse.core.runtime.jobs.Job;
import org.eclipse.jface.action.Action;
import org.eclipse.jface.action.IToolBarManager;
import org.eclipse.jface.action.Separator;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.swt.SWT;
import org.eclipse.swt.browser.Browser;
import org.eclipse.swt.custom.SashForm;
import org.eclipse.swt.custom.StyledText;
import org.eclipse.swt.events.KeyAdapter;
import org.eclipse.swt.events.KeyEvent;
import org.eclipse.swt.layout.GridData;
import org.eclipse.swt.layout.GridLayout;
import org.eclipse.swt.widgets.Button;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.swt.widgets.Display;
import org.eclipse.swt.widgets.Label;
import org.eclipse.swt.widgets.Text;
import org.eclipse.ui.ISharedImages;
import org.eclipse.ui.PlatformUI;
import org.eclipse.ui.part.ViewPart;

import com.abap.doc.plugin.GenerationResult;
import com.abap.doc.plugin.PluginConsole;
import com.abap.doc.plugin.dag.DagRunner;
import com.abap.doc.plugin.handler.SaveDocHandler;

public class ChatView extends ViewPart {

    public static final String ID = "com.abap.doc.chat.chatView";

    private SashForm sashForm;
    private Browser browser;
    private StyledText chatHistory;
    private Text inputField;
    private Button sendButton;
    private Label statusLabel;

    private Action saveAction;
    private Action applyAction;

    private final List<ChatMessage> conversation = new ArrayList<>();
    private String pendingUpdatedMarkdown;
    private String pendingUpdatedHtml;
    private String pendingUpdatedPageName;
    private File currentPagesDirectory;

    @Override
    public void createPartControl(Composite parent) {
        sashForm = new SashForm(parent, SWT.VERTICAL);

        // Top: embedded browser
        browser = new Browser(sashForm, SWT.NONE);
        browser.setText("<html><body style='font-family:sans-serif;color:#666;padding:40px;text-align:center;'>"
            + "<h2>ABAP Doc</h2><p>Generate documentation to see it here.</p></body></html>");

        // Bottom: chat panel
        Composite chatPanel = new Composite(sashForm, SWT.NONE);
        GridLayout chatLayout = new GridLayout(2, false);
        chatLayout.marginWidth = 4;
        chatLayout.marginHeight = 4;
        chatPanel.setLayout(chatLayout);

        // Chat history
        chatHistory = new StyledText(chatPanel, SWT.BORDER | SWT.MULTI | SWT.V_SCROLL | SWT.WRAP | SWT.READ_ONLY);
        GridData historyData = new GridData(SWT.FILL, SWT.FILL, true, true, 2, 1);
        chatHistory.setLayoutData(historyData);
        chatHistory.setBackground(Display.getCurrent().getSystemColor(SWT.COLOR_WHITE));

        // Input field
        inputField = new Text(chatPanel, SWT.BORDER | SWT.MULTI | SWT.WRAP | SWT.V_SCROLL);
        GridData inputData = new GridData(SWT.FILL, SWT.CENTER, true, false);
        inputData.heightHint = 60;
        inputField.setLayoutData(inputData);
        inputField.setMessage("Type a message... (Ctrl+Enter to send)");

        inputField.addKeyListener(new KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                if (e.character == SWT.CR && (e.stateMask & SWT.CTRL) != 0) {
                    e.doit = false;
                    handleSend();
                }
            }
        });

        // Send button
        sendButton = new Button(chatPanel, SWT.PUSH);
        sendButton.setText("Send");
        sendButton.setLayoutData(new GridData(SWT.RIGHT, SWT.CENTER, false, false));
        sendButton.addListener(SWT.Selection, e -> handleSend());

        // Status label
        statusLabel = new Label(chatPanel, SWT.NONE);
        statusLabel.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false, 2, 1));
        statusLabel.setText("Generate documentation to get started.");

        // Set sash weights: 70% browser, 30% chat
        sashForm.setWeights(new int[] { 70, 30 });

        // Toolbar actions
        createToolbar();
    }

    private void createToolbar() {
        IToolBarManager toolbar = getViewSite().getActionBars().getToolBarManager();
        ISharedImages sharedImages = PlatformUI.getWorkbench().getSharedImages();

        // Back
        Action backAction = new Action("Back") {
            @Override
            public void run() {
                if (browser != null && !browser.isDisposed()) browser.back();
            }
        };
        backAction.setToolTipText("Navigate Back");
        backAction.setImageDescriptor(sharedImages.getImageDescriptor(ISharedImages.IMG_TOOL_BACK));
        toolbar.add(backAction);

        // Forward
        Action forwardAction = new Action("Forward") {
            @Override
            public void run() {
                if (browser != null && !browser.isDisposed()) browser.forward();
            }
        };
        forwardAction.setToolTipText("Navigate Forward");
        forwardAction.setImageDescriptor(sharedImages.getImageDescriptor(ISharedImages.IMG_TOOL_FORWARD));
        toolbar.add(forwardAction);

        toolbar.add(new Separator());

        // Save
        saveAction = new Action("Save") {
            @Override
            public void run() {
                SaveDocHandler.performSave(getSite().getShell());
            }
        };
        saveAction.setToolTipText("Save Documentation (Ctrl+Shift+S)");
        saveAction.setImageDescriptor(sharedImages.getImageDescriptor(ISharedImages.IMG_ETOOL_SAVE_EDIT));
        saveAction.setDisabledImageDescriptor(sharedImages.getImageDescriptor(ISharedImages.IMG_ETOOL_SAVE_EDIT_DISABLED));
        saveAction.setEnabled(true);
        toolbar.add(saveAction);

        // Apply
        applyAction = new Action("Apply") {
            @Override
            public void run() {
                handleApply();
            }
        };
        applyAction.setToolTipText("Apply Chat Changes to Documentation");
        applyAction.setEnabled(false);
        toolbar.add(applyAction);

        getViewSite().getActionBars().updateActionBars();
    }

    /**
     * Loads single-object HTML into the embedded browser.
     * Called by GenerateDocHandler after generation.
     */
    public void showHtml(String html) {
        currentPagesDirectory = null;
        if (browser != null && !browser.isDisposed()) {
            browser.setText(html);
        }
        conversation.clear();
        chatHistory.setText("");
        statusLabel.setText("Documentation loaded. Chat below to refine.");
        pendingUpdatedMarkdown = null;
        pendingUpdatedHtml = null;
        applyAction.setEnabled(false);
    }

    /**
     * Loads package documentation via file URL so relative links work.
     * Called by GeneratePackageDocHandler after generation.
     */
    public void showPackageDoc(File pagesDir) {
        currentPagesDirectory = pagesDir;
        if (browser != null && !browser.isDisposed()) {
            File indexFile = new File(pagesDir, "index.html");
            browser.setUrl(indexFile.toURI().toString());
        }
        conversation.clear();
        chatHistory.setText("");
        statusLabel.setText("Package documentation loaded. Chat below to refine.");
        pendingUpdatedMarkdown = null;
        pendingUpdatedHtml = null;
        applyAction.setEnabled(false);
    }

    private void handleSend() {
        GenerationResult gr = GenerationResult.getInstance();
        if (!gr.hasResult()) {
            MessageDialog.openError(getSite().getShell(), "ABAP Doc",
                "No documentation available. Generate documentation first.");
            return;
        }

        String userText = inputField.getText().trim();
        if (userText.isEmpty()) return;

        conversation.add(new ChatMessage("user", userText));
        appendToChatHistory("You", userText);
        inputField.setText("");

        sendButton.setEnabled(false);
        statusLabel.setText("Sending...");

        String conversationJson = buildConversationJson();

        Job chatJob = new Job("ABAP Doc Chat") {
            @Override
            protected IStatus run(IProgressMonitor monitor) {
                try {
                    DagRunner runner = new DagRunner();
                    String result = runner.chat(
                        gr.getSystemUrl(), gr.getClient(), gr.getUsername(), gr.getPassword(),
                        gr.getObjectName(), gr.getObjectType(),
                        gr.getMarkdown() != null ? gr.getMarkdown() : "",
                        gr.getUserContext(),
                        conversationJson,
                        gr.getDocProvider(), gr.getDocApiKey(), gr.getDocModel(), gr.getDocBaseUrl(),
                        gr.isPackage(),
                        line -> PluginConsole.println(line)
                    );

                    String reply = extractJsonString(result, "reply");
                    String updatedMd = extractJsonString(result, "updatedMarkdown");
                    String updatedHtml = extractJsonString(result, "updatedHtml");
                    String updatedPageName = extractJsonString(result, "updatedPageName");
                    int promptTokens = extractInt(result, "promptTokens");
                    int completionTokens = extractInt(result, "completionTokens");
                    int totalTokens = promptTokens + completionTokens;
                    if (totalTokens > 0) {
                        PluginConsole.println("[chat] " + totalTokens + " tokens used (prompt: " + promptTokens + ", completion: " + completionTokens + ")");
                    }

                    Display.getDefault().asyncExec(() -> {
                        if (chatHistory.isDisposed()) return;

                        conversation.add(new ChatMessage("assistant", reply));
                        appendToChatHistory("Assistant", reply);

                        String tokenInfo = totalTokens > 0 ? " (" + totalTokens + " tokens)" : "";

                        if (updatedMd != null && !updatedMd.isEmpty()) {
                            pendingUpdatedMarkdown = updatedMd;
                            pendingUpdatedHtml = updatedHtml;
                            pendingUpdatedPageName = updatedPageName;
                            applyAction.setEnabled(true);

                            boolean apply = MessageDialog.openConfirm(
                                getSite().getShell(), "ABAP Doc",
                                "The documentation has been updated. Apply changes?");
                            if (apply) {
                                handleApply();
                            } else {
                                statusLabel.setText("Update available. Click Apply in the toolbar." + tokenInfo);
                            }
                        } else {
                            statusLabel.setText("Ready." + tokenInfo);
                        }

                        sendButton.setEnabled(true);
                    });

                    return Status.OK_STATUS;
                } catch (Exception e) {
                    Display.getDefault().asyncExec(() -> {
                        if (chatHistory.isDisposed()) return;
                        appendToChatHistory("System", "Error: " + e.getMessage());
                        sendButton.setEnabled(true);
                        statusLabel.setText("Error occurred. Try again.");
                    });
                    return Status.OK_STATUS;
                }
            }
        };
        chatJob.setUser(false);
        chatJob.schedule();
    }

    private void handleApply() {
        if (pendingUpdatedMarkdown == null) return;

        GenerationResult gr = GenerationResult.getInstance();

        try {
            gr.setMarkdown(pendingUpdatedMarkdown);

            if (pendingUpdatedHtml != null) {
                gr.setHtml(pendingUpdatedHtml);

                if (gr.isPackage() && currentPagesDirectory != null && pendingUpdatedPageName != null) {
                    // Write to the specific object page file
                    File pageFile = new File(currentPagesDirectory, pendingUpdatedPageName);
                    pageFile.getParentFile().mkdirs();
                    Files.writeString(pageFile.toPath(), pendingUpdatedHtml, StandardCharsets.UTF_8);
                    browser.setUrl(pageFile.toURI().toString());
                    PluginConsole.println("[chat] Updated page: " + pendingUpdatedPageName);
                } else if (gr.isPackage() && currentPagesDirectory != null) {
                    // Fallback: write to index
                    File indexFile = new File(currentPagesDirectory, "index.html");
                    Files.writeString(indexFile.toPath(), pendingUpdatedHtml, StandardCharsets.UTF_8);
                    browser.setUrl(indexFile.toURI().toString());
                } else {
                    // Single object: update browser in-place
                    browser.setText(pendingUpdatedHtml);
                }
            }

            appendToChatHistory("System", "Documentation updated.");
            statusLabel.setText("Documentation updated.");
            PluginConsole.println("[chat] Documentation updated via chat.");
        } catch (Exception e) {
            MessageDialog.openError(getSite().getShell(), "ABAP Doc",
                "Failed to apply update: " + e.getMessage());
        }

        pendingUpdatedMarkdown = null;
        pendingUpdatedHtml = null;
        pendingUpdatedPageName = null;
        applyAction.setEnabled(false);
    }

    private void appendToChatHistory(String sender, String message) {
        String formatted = sender + ": " + message + "\n\n";
        chatHistory.append(formatted);
        chatHistory.setTopIndex(chatHistory.getLineCount() - 1);
    }

    private String buildConversationJson() {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < conversation.size(); i++) {
            ChatMessage msg = conversation.get(i);
            if (i > 0) sb.append(",");
            sb.append("{\"role\":\"").append(DagRunner.escapeJson(msg.getRole())).append("\"");
            sb.append(",\"content\":\"").append(DagRunner.escapeJson(msg.getContent())).append("\"}");
        }
        sb.append("]");
        return sb.toString();
    }

    private static int extractInt(String json, String key) {
        String search = "\"" + key + "\":";
        int keyIdx = json.indexOf(search);
        if (keyIdx == -1) return 0;
        int afterKey = keyIdx + search.length();
        while (afterKey < json.length() && Character.isWhitespace(json.charAt(afterKey))) {
            afterKey++;
        }
        int start = afterKey;
        while (afterKey < json.length() && Character.isDigit(json.charAt(afterKey))) {
            afterKey++;
        }
        if (start == afterKey) return 0;
        try {
            return Integer.parseInt(json.substring(start, afterKey));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String extractJsonString(String json, String key) {
        String search = "\"" + key + "\":";
        int keyIdx = json.indexOf(search);
        if (keyIdx == -1) return null;

        int afterKey = keyIdx + search.length();
        while (afterKey < json.length() && Character.isWhitespace(json.charAt(afterKey))) {
            afterKey++;
        }
        if (afterKey >= json.length()) return null;
        if (json.startsWith("null", afterKey)) return null;
        if (json.charAt(afterKey) != '"') return null;

        StringBuilder value = new StringBuilder();
        int i = afterKey + 1;
        while (i < json.length()) {
            char c = json.charAt(i);
            if (c == '\\' && i + 1 < json.length()) {
                char next = json.charAt(i + 1);
                switch (next) {
                    case '"': value.append('"'); break;
                    case '\\': value.append('\\'); break;
                    case 'n': value.append('\n'); break;
                    case 'r': value.append('\r'); break;
                    case 't': value.append('\t'); break;
                    default: value.append('\\').append(next); break;
                }
                i += 2;
            } else if (c == '"') {
                return value.toString();
            } else {
                value.append(c);
                i++;
            }
        }
        return null;
    }

    @Override
    public void setFocus() {
        if (inputField != null && !inputField.isDisposed()) {
            inputField.setFocus();
        }
    }
}
