package com.abap.doc.plugin.handler;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.jface.dialogs.TitleAreaDialog;
import org.eclipse.swt.SWT;
import org.eclipse.swt.events.SelectionAdapter;
import org.eclipse.swt.events.SelectionEvent;
import org.eclipse.swt.graphics.Point;
import org.eclipse.swt.layout.GridData;
import org.eclipse.swt.layout.GridLayout;
import org.eclipse.swt.widgets.Button;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.swt.widgets.Control;
import org.eclipse.swt.widgets.FileDialog;
import org.eclipse.swt.widgets.Label;
import org.eclipse.swt.widgets.Shell;
import org.eclipse.swt.widgets.Spinner;
import org.eclipse.swt.widgets.Text;

public class TemplateManagerDialog extends TitleAreaDialog {

    /**
     * In-memory representation of a template.
     * Built-in templates have isBuiltIn=true and store their default values.
     */
    public static class TemplateItem {
        public String name;
        public String sections;
        public int maxWords;
        public int maxOutputTokens;
        public final boolean isBuiltIn;

        public TemplateItem(String name, String sections, int maxWords, int maxOutputTokens, boolean isBuiltIn) {
            this.name = name;
            this.sections = sections;
            this.maxWords = maxWords;
            this.maxOutputTokens = maxOutputTokens;
            this.isBuiltIn = isBuiltIn;
        }

        public TemplateItem copy() {
            return new TemplateItem(name, sections, maxWords, maxOutputTokens, false);
        }
    }

    // Built-in template defaults
    private static final String DEFAULT_SECTIONS =
        "Generate functional documentation with these sections. Only Overview is required — omit any other section if there is nothing meaningful to say:\n"
        + "- **Overview** (required) — what this object does from a business perspective, what problem it solves (1-2 paragraphs)\n"
        + "- **Functional Logic** (include only if non-trivial) — describe the business logic and key operations. Group by functional area, not by method name.\n"
        + "- **Dependencies** (include only if dependencies exist) — what other objects it relies on and what functional role each dependency plays\n"
        + "- **Where-Used** (include only if where-used data is available) — where this object is used and for what purpose.\n"
        + "- **Notes** (include only if noteworthy) — design decisions, limitations, edge cases";

    private static final String MINIMAL_SECTIONS =
        "Generate concise functional documentation. Only Overview is required — include Key Capabilities only if there is something meaningful to say:\n"
        + "- **Overview** (required) — what this object does from a business perspective, what problem it solves\n"
        + "- **Key Capabilities** (include only if non-trivial) — the main operations and behaviors it provides";

    private static final String DETAILED_SECTIONS =
        "Generate comprehensive functional documentation with these sections. Only Overview is required — omit any other section if there is nothing meaningful to say:\n"
        + "- **Overview** (required) — what this object does from a business perspective, what problem it solves, and its role in the application (1-2 paragraphs)\n"
        + "- **Functional Logic** (include only if non-trivial) — describe the business logic and key operations. Group by functional area, not by method name. Explain the processing flow, business rules, and decision logic.\n"
        + "- **Dependencies** (include only if dependencies exist) — what other objects it relies on and what functional role each dependency plays\n"
        + "- **Where-Used** (include only if where-used data is available) — where this object is used and for what purpose.\n"
        + "- **Error Handling** (include only if non-trivial) — what can go wrong, what business validations are performed\n"
        + "- **Notes** (include only if noteworthy) — design decisions, business constraints, known limitations";

    private final List<TemplateItem> templates;
    private org.eclipse.swt.widgets.List templateList;
    private Text nameField;
    private Text sectionsField;
    private Spinner maxWordsSpinner;
    private Spinner maxOutputTokensSpinner;
    private Button deleteButton;
    private Label infoLabel;
    private int currentIndex = -1;

    public TemplateManagerDialog(Shell parentShell, List<TemplateItem> existingTemplates) {
        super(parentShell);
        this.templates = new ArrayList<>();

        // Always include the three built-in templates
        addOrUpdateBuiltIn(existingTemplates, "Default", DEFAULT_SECTIONS, 1500, 8192);
        addOrUpdateBuiltIn(existingTemplates, "Minimal", MINIMAL_SECTIONS, 500, 4096);
        addOrUpdateBuiltIn(existingTemplates, "Detailed", DETAILED_SECTIONS, 3000, 16384);

        // Add custom templates
        for (TemplateItem t : existingTemplates) {
            if (!t.isBuiltIn) {
                templates.add(t);
            }
        }

        setShellStyle(getShellStyle() | SWT.RESIZE | SWT.MAX);
    }

    /**
     * If the user previously edited a built-in template, use their version.
     * Otherwise use the factory default.
     */
    private void addOrUpdateBuiltIn(List<TemplateItem> existing, String name, String defaultSections, int defaultMaxWords, int defaultMaxOutputTokens) {
        for (TemplateItem t : existing) {
            if (t.isBuiltIn && name.equals(t.name)) {
                templates.add(t);
                return;
            }
        }
        templates.add(new TemplateItem(name, defaultSections, defaultMaxWords, defaultMaxOutputTokens, true));
    }

    @Override
    public void create() {
        super.create();
        setTitle("Manage Documentation Templates");
        setMessage("Create, edit, and manage documentation templates. Built-in templates can be customized. "
            + "The sections field defines what the LLM is instructed to generate.");
    }

    @Override
    protected Control createDialogArea(Composite parent) {
        Composite area = (Composite) super.createDialogArea(parent);
        Composite container = new Composite(area, SWT.NONE);
        container.setLayoutData(new GridData(SWT.FILL, SWT.FILL, true, true));
        GridLayout layout = new GridLayout(2, false);
        layout.marginWidth = 10;
        layout.marginHeight = 10;
        container.setLayout(layout);

        // ─── Left panel: template list + buttons ───
        Composite leftPanel = new Composite(container, SWT.NONE);
        GridData leftGd = new GridData(SWT.FILL, SWT.FILL, false, true);
        leftGd.widthHint = 200;
        leftPanel.setLayoutData(leftGd);
        leftPanel.setLayout(new GridLayout(1, false));

        templateList = new org.eclipse.swt.widgets.List(leftPanel, SWT.BORDER | SWT.SINGLE | SWT.V_SCROLL);
        templateList.setLayoutData(new GridData(SWT.FILL, SWT.FILL, true, true));
        refreshList();

        templateList.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                saveCurrentToModel();
                int idx = templateList.getSelectionIndex();
                if (idx >= 0) {
                    loadTemplate(idx);
                }
            }
        });

        // Buttons
        Composite buttonPanel = new Composite(leftPanel, SWT.NONE);
        buttonPanel.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        buttonPanel.setLayout(new GridLayout(2, true));

        Button newBtn = new Button(buttonPanel, SWT.PUSH);
        newBtn.setText("New");
        newBtn.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        newBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                saveCurrentToModel();
                String name = generateUniqueName("New Template");
                TemplateItem item = new TemplateItem(name, DEFAULT_SECTIONS, 1500, 8192, false);
                templates.add(item);
                refreshList();
                templateList.setSelection(templates.size() - 1);
                loadTemplate(templates.size() - 1);
                nameField.setFocus();
                nameField.selectAll();
            }
        });

        Button duplicateBtn = new Button(buttonPanel, SWT.PUSH);
        duplicateBtn.setText("Duplicate");
        duplicateBtn.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        duplicateBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                saveCurrentToModel();
                if (currentIndex < 0) return;
                TemplateItem source = templates.get(currentIndex);
                TemplateItem dup = source.copy();
                dup.name = generateUniqueName(source.name + " Copy");
                templates.add(dup);
                refreshList();
                templateList.setSelection(templates.size() - 1);
                loadTemplate(templates.size() - 1);
            }
        });

        deleteButton = new Button(buttonPanel, SWT.PUSH);
        deleteButton.setText("Delete");
        deleteButton.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        deleteButton.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                if (currentIndex < 0) return;
                TemplateItem item = templates.get(currentIndex);
                if (item.isBuiltIn) {
                    MessageDialog.openInformation(getShell(), "Template Manager",
                        "Built-in templates cannot be deleted. You can duplicate and modify them.");
                    return;
                }
                if (!MessageDialog.openConfirm(getShell(), "Delete Template",
                    "Delete template \"" + item.name + "\"?")) {
                    return;
                }
                templates.remove(currentIndex);
                currentIndex = -1;
                refreshList();
                clearEditor();
                if (!templates.isEmpty()) {
                    templateList.setSelection(0);
                    loadTemplate(0);
                }
            }
        });

        // Import / Export row
        Button importBtn = new Button(buttonPanel, SWT.PUSH);
        importBtn.setText("Import...");
        importBtn.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        importBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                importTemplates();
            }
        });

        Button exportBtn = new Button(buttonPanel, SWT.PUSH);
        exportBtn.setText("Export...");
        exportBtn.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        exportBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                exportTemplates();
            }
        });

        // Reset built-in button
        Button resetBtn = new Button(leftPanel, SWT.PUSH);
        resetBtn.setText("Reset to Factory Default");
        resetBtn.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        resetBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                if (currentIndex < 0) return;
                TemplateItem item = templates.get(currentIndex);
                if (!item.isBuiltIn) {
                    MessageDialog.openInformation(getShell(), "Template Manager",
                        "Only built-in templates can be reset to factory defaults.");
                    return;
                }
                if (!MessageDialog.openConfirm(getShell(), "Reset Template",
                    "Reset \"" + item.name + "\" to factory defaults?")) {
                    return;
                }
                switch (item.name) {
                    case "Default":
                        item.sections = DEFAULT_SECTIONS;
                        item.maxWords = 1500;
                        item.maxOutputTokens = 8192;
                        break;
                    case "Minimal":
                        item.sections = MINIMAL_SECTIONS;
                        item.maxWords = 500;
                        item.maxOutputTokens = 4096;
                        break;
                    case "Detailed":
                        item.sections = DETAILED_SECTIONS;
                        item.maxWords = 3000;
                        item.maxOutputTokens = 16384;
                        break;
                }
                loadTemplate(currentIndex);
            }
        });

        // ─── Right panel: template editor ───
        Composite rightPanel = new Composite(container, SWT.NONE);
        rightPanel.setLayoutData(new GridData(SWT.FILL, SWT.FILL, true, true));
        rightPanel.setLayout(new GridLayout(2, false));

        // Name
        new Label(rightPanel, SWT.NONE).setText("Name:");
        nameField = new Text(rightPanel, SWT.BORDER);
        nameField.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));

        // Max Words
        new Label(rightPanel, SWT.NONE).setText("Max Words:");
        maxWordsSpinner = new Spinner(rightPanel, SWT.BORDER);
        maxWordsSpinner.setMinimum(100);
        maxWordsSpinner.setMaximum(10000);
        maxWordsSpinner.setIncrement(100);
        maxWordsSpinner.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));

        // Max Output Tokens
        new Label(rightPanel, SWT.NONE).setText("Max Output Tokens:");
        maxOutputTokensSpinner = new Spinner(rightPanel, SWT.BORDER);
        maxOutputTokensSpinner.setMinimum(1024);
        maxOutputTokensSpinner.setMaximum(32768);
        maxOutputTokensSpinner.setIncrement(1024);
        maxOutputTokensSpinner.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));

        // Sections (multi-line, spanning both columns)
        Label sectionsLabel = new Label(rightPanel, SWT.NONE);
        sectionsLabel.setText("Sections (LLM instructions):");
        GridData sectionsLabelGd = new GridData(SWT.LEFT, SWT.TOP, false, false, 2, 1);
        sectionsLabel.setLayoutData(sectionsLabelGd);

        sectionsField = new Text(rightPanel, SWT.MULTI | SWT.BORDER | SWT.WRAP | SWT.V_SCROLL);
        GridData sectionsGd = new GridData(SWT.FILL, SWT.FILL, true, true, 2, 1);
        sectionsGd.heightHint = 250;
        sectionsField.setLayoutData(sectionsGd);

        // Info label
        infoLabel = new Label(rightPanel, SWT.WRAP);
        GridData infoGd = new GridData(SWT.FILL, SWT.CENTER, true, false, 2, 1);
        infoLabel.setLayoutData(infoGd);

        clearEditor();

        // Select first template
        if (!templates.isEmpty()) {
            templateList.setSelection(0);
            loadTemplate(0);
        }

        return area;
    }

    private void refreshList() {
        templateList.removeAll();
        for (TemplateItem t : templates) {
            String label = t.isBuiltIn ? t.name + " (built-in)" : t.name;
            templateList.add(label);
        }
    }

    private void loadTemplate(int index) {
        currentIndex = index;
        TemplateItem item = templates.get(index);
        nameField.setText(item.name);
        sectionsField.setText(item.sections);
        maxWordsSpinner.setSelection(item.maxWords);
        maxOutputTokensSpinner.setSelection(item.maxOutputTokens);

        // Built-in templates: name is not editable, but sections/limits are
        nameField.setEnabled(!item.isBuiltIn);
        sectionsField.setEnabled(true);
        maxWordsSpinner.setEnabled(true);
        maxOutputTokensSpinner.setEnabled(true);
        deleteButton.setEnabled(!item.isBuiltIn);

        if (item.isBuiltIn) {
            infoLabel.setText("Built-in template. Name is fixed but you can customize sections and limits. "
                + "Note: built-in templates also have object-type-specific variants (Class, Program, CDS) "
                + "that are generated at documentation time. Editing here changes the base template.");
        } else {
            infoLabel.setText("Custom template. The sections text is passed directly to the LLM as instructions.");
        }
    }

    private void clearEditor() {
        nameField.setText("");
        sectionsField.setText("");
        maxWordsSpinner.setSelection(1500);
        maxOutputTokensSpinner.setSelection(8192);
        nameField.setEnabled(false);
        sectionsField.setEnabled(false);
        maxWordsSpinner.setEnabled(false);
        maxOutputTokensSpinner.setEnabled(false);
        deleteButton.setEnabled(false);
        infoLabel.setText("Select a template from the list to edit.");
    }

    private void saveCurrentToModel() {
        if (currentIndex < 0 || currentIndex >= templates.size()) return;
        TemplateItem item = templates.get(currentIndex);
        if (!item.isBuiltIn) {
            item.name = nameField.getText().trim();
        }
        item.sections = sectionsField.getText();
        item.maxWords = maxWordsSpinner.getSelection();
        item.maxOutputTokens = maxOutputTokensSpinner.getSelection();
        // Refresh the list label in case name changed
        String label = item.isBuiltIn ? item.name + " (built-in)" : item.name;
        templateList.setItem(currentIndex, label);
    }

    private String generateUniqueName(String baseName) {
        String name = baseName;
        int counter = 1;
        while (nameExists(name)) {
            counter++;
            name = baseName + " " + counter;
        }
        return name;
    }

    private boolean nameExists(String name) {
        for (TemplateItem t : templates) {
            if (t.name.equalsIgnoreCase(name)) return true;
        }
        return false;
    }

    private void importTemplates() {
        FileDialog fd = new FileDialog(getShell(), SWT.OPEN);
        fd.setFilterNames(new String[] { "JSON Files (*.json)", "All Files (*.*)" });
        fd.setFilterExtensions(new String[] { "*.json", "*.*" });
        fd.setText("Import Templates");
        String path = fd.open();
        if (path == null) return;

        try {
            String content = Files.readString(Path.of(path), StandardCharsets.UTF_8);
            List<TemplateItem> imported = parseTemplatesJson(content);
            if (imported.isEmpty()) {
                MessageDialog.openInformation(getShell(), "Import", "No templates found in file.");
                return;
            }
            saveCurrentToModel();
            for (TemplateItem t : imported) {
                t.name = generateUniqueName(t.name);
                templates.add(t);
            }
            refreshList();
            templateList.setSelection(templates.size() - 1);
            loadTemplate(templates.size() - 1);
            MessageDialog.openInformation(getShell(), "Import", "Imported " + imported.size() + " template(s).");
        } catch (IOException ex) {
            MessageDialog.openError(getShell(), "Import Error", "Failed to read file: " + ex.getMessage());
        }
    }

    private void exportTemplates() {
        if (currentIndex < 0) return;
        saveCurrentToModel();

        FileDialog fd = new FileDialog(getShell(), SWT.SAVE);
        fd.setFilterNames(new String[] { "JSON Files (*.json)" });
        fd.setFilterExtensions(new String[] { "*.json" });
        fd.setFileName("templates.json");
        fd.setText("Export Template");
        String path = fd.open();
        if (path == null) return;

        try {
            TemplateItem item = templates.get(currentIndex);
            String json = "[" + templateToJson(item) + "]";
            Files.writeString(Path.of(path), json, StandardCharsets.UTF_8);
            MessageDialog.openInformation(getShell(), "Export", "Template exported to " + path);
        } catch (IOException ex) {
            MessageDialog.openError(getShell(), "Export Error", "Failed to write file: " + ex.getMessage());
        }
    }

    @Override
    protected void okPressed() {
        saveCurrentToModel();
        // Validate: no duplicate names
        for (int i = 0; i < templates.size(); i++) {
            for (int j = i + 1; j < templates.size(); j++) {
                if (templates.get(i).name.equalsIgnoreCase(templates.get(j).name)) {
                    MessageDialog.openError(getShell(), "Validation Error",
                        "Duplicate template name: \"" + templates.get(i).name + "\". Each template must have a unique name.");
                    return;
                }
            }
        }
        // Validate: no empty names
        for (TemplateItem t : templates) {
            if (t.name.isEmpty()) {
                MessageDialog.openError(getShell(), "Validation Error", "Template name cannot be empty.");
                return;
            }
        }
        super.okPressed();
    }

    public List<TemplateItem> getTemplates() {
        return templates;
    }

    @Override
    protected boolean isResizable() {
        return true;
    }

    @Override
    protected Point getInitialSize() {
        return new Point(900, 650);
    }

    // ─── JSON serialization (minimal, no library) ───

    public static String templatesToJson(List<TemplateItem> items) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append(templateToJson(items.get(i)));
        }
        sb.append("]");
        return sb.toString();
    }

    private static String templateToJson(TemplateItem item) {
        return "{\"name\":\"" + escapeJson(item.name) + "\""
            + ",\"sections\":\"" + escapeJson(item.sections) + "\""
            + ",\"maxWords\":" + item.maxWords
            + ",\"maxOutputTokens\":" + item.maxOutputTokens
            + ",\"isBuiltIn\":" + item.isBuiltIn
            + "}";
    }

    public static List<TemplateItem> parseTemplatesJson(String json) {
        List<TemplateItem> result = new ArrayList<>();
        if (json == null || json.trim().isEmpty() || json.trim().equals("[]")) return result;

        // Minimal JSON array-of-objects parser
        String trimmed = json.trim();
        if (!trimmed.startsWith("[")) return result;

        int i = 1; // skip '['
        while (i < trimmed.length()) {
            // Find next '{'
            int objStart = trimmed.indexOf('{', i);
            if (objStart == -1) break;

            // Find matching '}'
            int braceCount = 0;
            int objEnd = -1;
            for (int j = objStart; j < trimmed.length(); j++) {
                char c = trimmed.charAt(j);
                if (c == '\\') { j++; continue; } // skip escaped
                if (c == '"') {
                    // skip string
                    j++;
                    while (j < trimmed.length()) {
                        if (trimmed.charAt(j) == '\\') { j++; }
                        else if (trimmed.charAt(j) == '"') break;
                        j++;
                    }
                    continue;
                }
                if (c == '{') braceCount++;
                if (c == '}') {
                    braceCount--;
                    if (braceCount == 0) { objEnd = j; break; }
                }
            }
            if (objEnd == -1) break;

            String objStr = trimmed.substring(objStart, objEnd + 1);
            TemplateItem item = parseOneTemplate(objStr);
            if (item != null) result.add(item);
            i = objEnd + 1;
        }

        return result;
    }

    private static TemplateItem parseOneTemplate(String obj) {
        String name = extractStringField(obj, "name");
        String sections = extractStringField(obj, "sections");
        int maxWords = extractIntField(obj, "maxWords", 1500);
        int maxOutputTokens = extractIntField(obj, "maxOutputTokens", 8192);
        boolean isBuiltIn = extractBoolField(obj, "isBuiltIn");

        if (name == null || name.isEmpty()) return null;
        if (sections == null) sections = "";

        return new TemplateItem(name, sections, maxWords, maxOutputTokens, isBuiltIn);
    }

    private static String extractStringField(String json, String field) {
        String key = "\"" + field + "\":\"";
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

    private static int extractIntField(String json, String field, int defaultValue) {
        String key = "\"" + field + "\":";
        int start = json.indexOf(key);
        if (start == -1) return defaultValue;
        start += key.length();
        StringBuilder digits = new StringBuilder();
        for (int i = start; i < json.length(); i++) {
            char c = json.charAt(i);
            if (Character.isDigit(c)) digits.append(c);
            else if (digits.length() > 0) break;
        }
        if (digits.length() == 0) return defaultValue;
        try { return Integer.parseInt(digits.toString()); }
        catch (NumberFormatException e) { return defaultValue; }
    }

    private static boolean extractBoolField(String json, String field) {
        String key = "\"" + field + "\":";
        int start = json.indexOf(key);
        if (start == -1) return false;
        start += key.length();
        String rest = json.substring(start).trim();
        return rest.startsWith("true");
    }

    private static String escapeJson(String value) {
        if (value == null) return "";
        return value.replace("\\", "\\\\")
                     .replace("\"", "\\\"")
                     .replace("\n", "\\n")
                     .replace("\r", "\\r")
                     .replace("\t", "\\t");
    }
}
