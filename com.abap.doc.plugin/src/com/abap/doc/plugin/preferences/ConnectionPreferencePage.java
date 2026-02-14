package com.abap.doc.plugin.preferences;

import org.eclipse.jface.preference.ComboFieldEditor;
import org.eclipse.jface.preference.FieldEditorPreferencePage;
import org.eclipse.jface.preference.IntegerFieldEditor;
import org.eclipse.jface.preference.StringFieldEditor;
import org.eclipse.ui.IWorkbench;
import org.eclipse.ui.IWorkbenchPreferencePage;

import com.abap.doc.plugin.Activator;

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

    // Processing mode
    public static final String PREF_MODE = "docMode";

    // Token budget
    public static final String PREF_MAX_TOKENS = "maxTotalTokens";

    // Documentation template
    public static final String PREF_TEMPLATE = "docTemplate";
    public static final String PREF_TEMPLATE_CUSTOM = "docTemplateCustom";

    // Save path
    public static final String PREF_SAVE_PATH = "docSavePath";

    // Confluence
    public static final String PREF_CONFLUENCE_URL = "confluenceUrl";
    public static final String PREF_CONFLUENCE_SPACE = "confluenceSpace";
    public static final String PREF_CONFLUENCE_PARENT_ID = "confluenceParentId";
    public static final String PREF_CONFLUENCE_USERNAME = "confluenceUsername";
    public static final String PREF_CONFLUENCE_TOKEN = "confluenceToken";

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

    private static final String[][] TEMPLATE_OPTIONS = {
        { "Default", "default" },
        { "Minimal", "minimal" },
        { "Detailed", "detailed" },
        { "Custom", "custom" },
    };

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

        // Mode
        addField(new ComboFieldEditor(PREF_MODE, "Processing Mode:", new String[][] {
            { "Real-time (instant, full price)", "realtime" },
            { "Batch (async, 50% discount)", "batch" },
        }, getFieldEditorParent()));

        // Token budget
        IntegerFieldEditor maxTokensField = new IntegerFieldEditor(
            PREF_MAX_TOKENS, "Max Total Tokens (0 = unlimited):", getFieldEditorParent());
        maxTokensField.setValidRange(0, 10_000_000);
        addField(maxTokensField);

        // Documentation template
        addField(new ComboFieldEditor(PREF_TEMPLATE, "Documentation Template:", TEMPLATE_OPTIONS, getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_TEMPLATE_CUSTOM, "Custom Template (when Custom selected):", getFieldEditorParent()));

        // Save location
        addField(new StringFieldEditor(PREF_SAVE_PATH, "Default Save Directory:", getFieldEditorParent()));

        // Confluence
        addField(new StringFieldEditor(PREF_CONFLUENCE_URL, "Confluence URL:", getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_CONFLUENCE_SPACE, "Confluence Space Key:", getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_CONFLUENCE_PARENT_ID, "Confluence Parent Page ID (optional):", getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_CONFLUENCE_USERNAME, "Confluence Username:", getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_CONFLUENCE_TOKEN, "Confluence API Token:", getFieldEditorParent()));
    }

    @Override
    public void init(IWorkbench workbench) {
    }
}
