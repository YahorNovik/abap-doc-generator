package com.abap.doc.plugin.chat;

import java.io.File;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Status;
import org.eclipse.core.runtime.jobs.Job;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.swt.SWT;
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
import org.eclipse.ui.browser.IWorkbenchBrowserSupport;
import org.eclipse.ui.PlatformUI;
import org.eclipse.ui.part.ViewPart;

import com.abap.doc.plugin.GenerationResult;
import com.abap.doc.plugin.PluginConsole;
import com.abap.doc.plugin.dag.DagRunner;

public class ChatView extends ViewPart {

    public static final String ID = "com.abap.doc.chat.chatView";

    private StyledText chatHistory;
    private Text inputField;
    private Button sendButton;
    private Button applyButton;
    private Label statusLabel;

    private final List<ChatMessage> conversation = new ArrayList<>();
    private String pendingUpdatedMarkdown;
    private String pendingUpdatedHtml;

    @Override
    public void createPartControl(Composite parent) {
        Composite container = new Composite(parent, SWT.NONE);
        GridLayout layout = new GridLayout(2, false);
        layout.marginWidth = 4;
        layout.marginHeight = 4;
        container.setLayout(layout);

        // Chat history (read-only, scrollable)
        chatHistory = new StyledText(container, SWT.BORDER | SWT.MULTI | SWT.V_SCROLL | SWT.WRAP | SWT.READ_ONLY);
        GridData historyData = new GridData(SWT.FILL, SWT.FILL, true, true, 2, 1);
        historyData.heightHint = 300;
        chatHistory.setLayoutData(historyData);
        chatHistory.setBackground(Display.getCurrent().getSystemColor(SWT.COLOR_WHITE));

        // Input field (multi-line)
        inputField = new Text(container, SWT.BORDER | SWT.MULTI | SWT.WRAP | SWT.V_SCROLL);
        GridData inputData = new GridData(SWT.FILL, SWT.CENTER, true, false);
        inputData.heightHint = 60;
        inputField.setLayoutData(inputData);
        inputField.setMessage("Type a message... (Ctrl+Enter to send)");

        // Ctrl+Enter to send
        inputField.addKeyListener(new KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                if (e.character == SWT.CR && (e.stateMask & SWT.CTRL) != 0) {
                    e.doit = false;
                    handleSend();
                }
            }
        });

        // Button panel
        Composite buttonPanel = new Composite(container, SWT.NONE);
        GridLayout buttonLayout = new GridLayout(2, true);
        buttonLayout.marginWidth = 0;
        buttonLayout.marginHeight = 0;
        buttonPanel.setLayout(buttonLayout);
        buttonPanel.setLayoutData(new GridData(SWT.RIGHT, SWT.CENTER, false, false));

        sendButton = new Button(buttonPanel, SWT.PUSH);
        sendButton.setText("Send");
        sendButton.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        sendButton.addListener(SWT.Selection, e -> handleSend());

        applyButton = new Button(buttonPanel, SWT.PUSH);
        applyButton.setText("Apply");
        applyButton.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        applyButton.setEnabled(false);
        applyButton.addListener(SWT.Selection, e -> handleApply());

        // Status label
        statusLabel = new Label(container, SWT.NONE);
        statusLabel.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false, 2, 1));
        statusLabel.setText("Ready. Generate documentation first, then chat here.");
    }

    private void handleSend() {
        GenerationResult gr = GenerationResult.getInstance();
        if (!gr.hasResult()) {
            MessageDialog.openError(getSite().getShell(), "ABAP Doc Chat",
                "No documentation available. Generate documentation first.");
            return;
        }

        String userText = inputField.getText().trim();
        if (userText.isEmpty()) return;

        // Add to conversation and display
        conversation.add(new ChatMessage("user", userText));
        appendToChatHistory("You", userText);
        inputField.setText("");

        // Disable send while processing
        sendButton.setEnabled(false);
        statusLabel.setText("Sending...");

        // Build conversation JSON
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
                        line -> PluginConsole.println(line)
                    );

                    // Parse JSON response
                    String reply = extractJsonString(result, "reply");
                    String updatedMd = extractJsonString(result, "updatedMarkdown");
                    String updatedHtml = extractJsonString(result, "updatedHtml");

                    Display.getDefault().asyncExec(() -> {
                        if (chatHistory.isDisposed()) return;

                        conversation.add(new ChatMessage("assistant", reply));
                        appendToChatHistory("Assistant", reply);

                        if (updatedMd != null && !updatedMd.isEmpty()) {
                            pendingUpdatedMarkdown = updatedMd;
                            pendingUpdatedHtml = updatedHtml;
                            applyButton.setEnabled(true);
                            statusLabel.setText("Update available. Click Apply to update the documentation.");
                        } else {
                            statusLabel.setText("Ready.");
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
            // Update GenerationResult
            gr.setMarkdown(pendingUpdatedMarkdown);
            if (pendingUpdatedHtml != null) {
                gr.setHtml(pendingUpdatedHtml);

                // Write to temp file and open in browser
                File tempFile = File.createTempFile("abap-doc-chat-", ".html");
                tempFile.deleteOnExit();
                Files.writeString(tempFile.toPath(), pendingUpdatedHtml, StandardCharsets.UTF_8);
                gr.setHtmlFile(tempFile);

                IWorkbenchBrowserSupport browserSupport = PlatformUI.getWorkbench().getBrowserSupport();
                browserSupport.createBrowser(
                    IWorkbenchBrowserSupport.LOCATION_BAR | IWorkbenchBrowserSupport.NAVIGATION_BAR,
                    "abap-doc-chat-preview", "ABAP Doc (Updated)", null
                ).openURL(tempFile.toURI().toURL());
            }

            appendToChatHistory("System", "Documentation updated and browser refreshed.");
            statusLabel.setText("Documentation updated.");
            PluginConsole.println("[chat] Documentation updated via chat.");
        } catch (Exception e) {
            MessageDialog.openError(getSite().getShell(), "ABAP Doc Chat",
                "Failed to apply update: " + e.getMessage());
        }

        pendingUpdatedMarkdown = null;
        pendingUpdatedHtml = null;
        applyButton.setEnabled(false);
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

    /**
     * Simple JSON string field extractor (avoids pulling in a JSON library).
     * Handles escaped quotes within the value.
     */
    private static String extractJsonString(String json, String key) {
        String search = "\"" + key + "\":";
        int keyIdx = json.indexOf(search);
        if (keyIdx == -1) return null;

        int afterKey = keyIdx + search.length();
        // Skip whitespace
        while (afterKey < json.length() && Character.isWhitespace(json.charAt(afterKey))) {
            afterKey++;
        }
        if (afterKey >= json.length()) return null;

        // Check for null
        if (json.startsWith("null", afterKey)) return null;

        // Must start with quote
        if (json.charAt(afterKey) != '"') return null;

        // Find end of string, handling escapes
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
