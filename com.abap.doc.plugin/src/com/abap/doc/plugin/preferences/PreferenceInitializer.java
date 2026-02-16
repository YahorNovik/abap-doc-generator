package com.abap.doc.plugin.preferences;

import org.eclipse.core.runtime.preferences.AbstractPreferenceInitializer;
import org.eclipse.jface.preference.IPreferenceStore;

import com.abap.doc.plugin.Activator;

public class PreferenceInitializer extends AbstractPreferenceInitializer {

    @Override
    public void initializeDefaultPreferences() {
        IPreferenceStore store = Activator.getDefault().getPreferenceStore();

        // Summary LLM defaults
        store.setDefault(ConnectionPreferencePage.PREF_SUMMARY_PROVIDER, "gemini");
        store.setDefault(ConnectionPreferencePage.PREF_SUMMARY_MODEL, "gemini-2.5-flash");

        // Documentation LLM defaults
        store.setDefault(ConnectionPreferencePage.PREF_DOC_PROVIDER, "gemini");
        store.setDefault(ConnectionPreferencePage.PREF_DOC_MODEL, "gemini-2.5-pro");

        // Token budget default (0 = unlimited)
        store.setDefault(ConnectionPreferencePage.PREF_MAX_TOKENS, 500000);

        // Documentation template default
        store.setDefault(ConnectionPreferencePage.PREF_TEMPLATE, "Default");
        store.setDefault(ConnectionPreferencePage.PREF_CUSTOM_TEMPLATES, "[]");

        // Sub-package depth (2 levels by default)
        store.setDefault(ConnectionPreferencePage.PREF_MAX_SUBPACKAGE_DEPTH, 2);

        // Save path default (empty = always ask)
        store.setDefault(ConnectionPreferencePage.PREF_SAVE_PATH, "");
    }
}
