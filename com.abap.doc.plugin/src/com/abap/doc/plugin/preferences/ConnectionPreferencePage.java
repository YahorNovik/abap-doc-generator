package com.abap.doc.plugin.preferences;

import java.util.ArrayList;
import java.util.List;

import org.eclipse.jface.preference.ComboFieldEditor;
import org.eclipse.jface.preference.FieldEditorPreferencePage;
import org.eclipse.jface.preference.IPreferenceStore;
import org.eclipse.jface.preference.IntegerFieldEditor;
import org.eclipse.jface.preference.StringFieldEditor;
import org.eclipse.jface.window.Window;
import org.eclipse.swt.SWT;
import org.eclipse.swt.events.SelectionAdapter;
import org.eclipse.swt.events.SelectionEvent;
import org.eclipse.swt.layout.GridData;
import org.eclipse.swt.widgets.Button;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.ui.IWorkbench;
import org.eclipse.ui.IWorkbenchPreferencePage;

import com.abap.doc.plugin.Activator;
import com.abap.doc.plugin.handler.TemplateManagerDialog;
import com.abap.doc.plugin.handler.TemplateManagerDialog.TemplateItem;

public class ConnectionPreferencePage extends FieldEditorPreferencePage implements IWorkbenchPreferencePage {

    // SAP connection
    public static final String PREF_SYSTEM_URL = "systemUrl";
    public static final String PREF_CLIENT = "client";
    public static final String PREF_USERNAME = "username";
    public static final String PREF_PASSWORD = "password";

    // Summary LLM (cheap/fast model for dependency summaries)
    public static final String PREF_SUMMARY_PROVIDER = "summaryLlmProvider";
    public static final String PREF_SUMMARY_API_KEY = "summaryLlmApiKey";
    public static final String PREF_SUMMARY_MODEL = "summaryLlmModel";
    public static final String PREF_SUMMARY_BASE_URL = "summaryLlmBaseUrl";

    // Documentation LLM (capable model for final documentation)
    public static final String PREF_DOC_PROVIDER = "docLlmProvider";
    public static final String PREF_DOC_API_KEY = "docLlmApiKey";
    public static final String PREF_DOC_MODEL = "docLlmModel";
    public static final String PREF_DOC_BASE_URL = "docLlmBaseUrl";

    // Token budget
    public static final String PREF_MAX_TOKENS = "maxTotalTokens";

    // Documentation template — selected template name
    public static final String PREF_TEMPLATE = "docTemplate";
    // Legacy: single custom template text (kept for backward compatibility)
    public static final String PREF_TEMPLATE_CUSTOM = "docTemplateCustom";
    // New: all templates as JSON array
    public static final String PREF_CUSTOM_TEMPLATES = "customTemplates";

    // Save path
    public static final String PREF_SAVE_PATH = "docSavePath";

    // Sub-package depth
    public static final String PREF_MAX_SUBPACKAGE_DEPTH = "maxSubPackageDepth";

    private static final String[][] PROVIDER_OPTIONS = {
        { "Gemini", "gemini" },
        { "OpenAI", "openai" },
        { "OpenAI-compatible", "openai-compatible" }
    };

    private static final String[][] MODEL_OPTIONS = {
        // Gemini
        { "Gemini 3 Pro (preview)", "gemini-3-pro-preview" },
        { "Gemini 3 Flash (preview)", "gemini-3-flash-preview" },
        { "Gemini 2.5 Pro", "gemini-2.5-pro" },
        { "Gemini 2.5 Flash", "gemini-2.5-flash" },
        { "Gemini 2.5 Flash Lite", "gemini-2.5-flash-lite" },
        // OpenAI
        { "GPT-5.2", "gpt-5.2" },
        { "GPT-5", "gpt-5" },
        { "GPT-5 Mini", "gpt-5-mini" },
        { "GPT-5 Nano", "gpt-5-nano" },
        { "GPT-4.1", "gpt-4.1" },
        { "GPT-4.1 Mini", "gpt-4.1-mini" },
        { "GPT-4.1 Nano", "gpt-4.1-nano" },
        { "GPT-4o", "gpt-4o" },
        { "GPT-4o Mini", "gpt-4o-mini" },
    };

    private ComboFieldEditor templateCombo;

    public ConnectionPreferencePage() {
        super(GRID);
        setPreferenceStore(Activator.getDefault().getPreferenceStore());
        setDescription("ABAP Doc Generator Settings");
    }

    @Override
    protected void createFieldEditors() {
        // SAP Connection
        addField(new StringFieldEditor(PREF_SYSTEM_URL, "System URL:", getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_CLIENT, "Client:", getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_USERNAME, "Username:", getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_PASSWORD, "Password:", getFieldEditorParent()));

        // Summary LLM
        addField(new ComboFieldEditor(PREF_SUMMARY_PROVIDER, "Summary LLM Provider:", PROVIDER_OPTIONS, getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_SUMMARY_API_KEY, "Summary LLM API Key:", getFieldEditorParent()));
        addField(new ComboFieldEditor(PREF_SUMMARY_MODEL, "Summary LLM Model:", MODEL_OPTIONS, getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_SUMMARY_BASE_URL, "Summary LLM Base URL (optional):", getFieldEditorParent()));

        // Documentation LLM
        addField(new ComboFieldEditor(PREF_DOC_PROVIDER, "Doc LLM Provider:", PROVIDER_OPTIONS, getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_DOC_API_KEY, "Doc LLM API Key:", getFieldEditorParent()));
        addField(new ComboFieldEditor(PREF_DOC_MODEL, "Doc LLM Model:", MODEL_OPTIONS, getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_DOC_BASE_URL, "Doc LLM Base URL (optional):", getFieldEditorParent()));

        // Token budget
        IntegerFieldEditor maxTokensField = new IntegerFieldEditor(
            PREF_MAX_TOKENS, "Max Total Tokens (0 = unlimited):", getFieldEditorParent());
        maxTokensField.setValidRange(0, 10_000_000);
        addField(maxTokensField);

        // Documentation template — dropdown with all available templates
        String[][] templateOptions = buildTemplateOptions();
        templateCombo = new ComboFieldEditor(PREF_TEMPLATE, "Documentation Template:", templateOptions, getFieldEditorParent());
        addField(templateCombo);

        // "Manage Templates..." button
        Composite parent = getFieldEditorParent();
        Button manageBtn = new Button(parent, SWT.PUSH);
        manageBtn.setText("Manage Templates...");
        manageBtn.setLayoutData(new GridData(SWT.LEFT, SWT.CENTER, false, false));
        manageBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                openTemplateManager();
            }
        });

        // Sub-package depth
        IntegerFieldEditor depthField = new IntegerFieldEditor(PREF_MAX_SUBPACKAGE_DEPTH, "Sub-Package Depth (0 = root only):", getFieldEditorParent());
        depthField.setValidRange(0, 5);
        addField(depthField);

        // Save location
        addField(new StringFieldEditor(PREF_SAVE_PATH, "Default Save Directory:", getFieldEditorParent()));
    }

    private String[][] buildTemplateOptions() {
        IPreferenceStore store = Activator.getDefault().getPreferenceStore();
        String json = store.getString(PREF_CUSTOM_TEMPLATES);
        List<TemplateItem> templates = TemplateManagerDialog.parseTemplatesJson(json);

        // Always include the three built-in options
        List<String[]> options = new ArrayList<>();
        options.add(new String[] { "Default", "Default" });
        options.add(new String[] { "Minimal", "Minimal" });
        options.add(new String[] { "Detailed", "Detailed" });

        // Add custom templates (skip built-in duplicates)
        for (TemplateItem t : templates) {
            if (!t.isBuiltIn && !t.name.isEmpty()) {
                options.add(new String[] { t.name, t.name });
            }
        }

        return options.toArray(new String[0][]);
    }

    private void openTemplateManager() {
        IPreferenceStore store = Activator.getDefault().getPreferenceStore();
        String json = store.getString(PREF_CUSTOM_TEMPLATES);
        List<TemplateItem> existing = TemplateManagerDialog.parseTemplatesJson(json);

        TemplateManagerDialog dialog = new TemplateManagerDialog(getShell(), existing);
        if (dialog.open() == Window.OK) {
            List<TemplateItem> updated = dialog.getTemplates();
            String updatedJson = TemplateManagerDialog.templatesToJson(updated);
            store.setValue(PREF_CUSTOM_TEMPLATES, updatedJson);

            // Rebuild the template dropdown to include new custom templates
            // FieldEditorPreferencePage doesn't support dynamic combo updates easily,
            // so we inform the user
            org.eclipse.jface.dialogs.MessageDialog.openInformation(getShell(), "Templates Updated",
                "Templates saved. Re-open preferences to see new templates in the dropdown.");
        }
    }

    @Override
    public void init(IWorkbench workbench) {
    }

    /**
     * Resolves the selected template to the sections text and config values.
     * Used by handlers to get the actual template content.
     * Returns null if it's a built-in template (let Node.js side handle resolution).
     */
    public static TemplateItem resolveSelectedTemplate(IPreferenceStore store) {
        String selectedName = store.getString(PREF_TEMPLATE);
        if (selectedName == null || selectedName.isEmpty()) return null;

        // Check if it's a standard built-in name (let the TS side handle these by default)
        // But the user might have customized even built-in templates
        String json = store.getString(PREF_CUSTOM_TEMPLATES);
        List<TemplateItem> templates = TemplateManagerDialog.parseTemplatesJson(json);

        for (TemplateItem t : templates) {
            if (t.name.equals(selectedName)) {
                return t;
            }
        }

        // Not found in stored templates — it's a built-in with no customization
        return null;
    }
}
