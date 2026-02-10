package com.abap.doc.plugin.preferences;

import org.eclipse.jface.preference.FieldEditorPreferencePage;
import org.eclipse.jface.preference.StringFieldEditor;
import org.eclipse.ui.IWorkbench;
import org.eclipse.ui.IWorkbenchPreferencePage;

import com.abap.doc.plugin.Activator;

public class ConnectionPreferencePage extends FieldEditorPreferencePage implements IWorkbenchPreferencePage {

    public static final String PREF_SYSTEM_URL = "systemUrl";
    public static final String PREF_CLIENT = "client";
    public static final String PREF_USERNAME = "username";
    public static final String PREF_PASSWORD = "password";

    public ConnectionPreferencePage() {
        super(GRID);
        setPreferenceStore(Activator.getDefault().getPreferenceStore());
        setDescription("SAP System Connection Settings");
    }

    @Override
    protected void createFieldEditors() {
        addField(new StringFieldEditor(PREF_SYSTEM_URL, "System URL:", getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_CLIENT, "Client:", getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_USERNAME, "Username:", getFieldEditorParent()));
        addField(new StringFieldEditor(PREF_PASSWORD, "Password:", getFieldEditorParent()));
    }

    @Override
    public void init(IWorkbench workbench) {
    }
}
