package com.abap.doc.plugin.handler;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.eclipse.jface.dialogs.TitleAreaDialog;
import org.eclipse.jface.viewers.ArrayContentProvider;
import org.eclipse.jface.viewers.CellEditor;
import org.eclipse.jface.viewers.ColumnLabelProvider;
import org.eclipse.jface.viewers.ComboBoxCellEditor;
import org.eclipse.jface.viewers.EditingSupport;
import org.eclipse.jface.viewers.TableViewer;
import org.eclipse.jface.viewers.TableViewerColumn;
import org.eclipse.swt.SWT;
import org.eclipse.swt.events.SelectionAdapter;
import org.eclipse.swt.events.SelectionEvent;
import org.eclipse.swt.graphics.Point;
import org.eclipse.swt.layout.GridData;
import org.eclipse.swt.layout.GridLayout;
import org.eclipse.swt.widgets.Button;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.swt.widgets.Control;
import org.eclipse.swt.widgets.Label;
import org.eclipse.swt.widgets.Shell;

import com.abap.doc.plugin.PluginConsole;
import com.abap.doc.plugin.dag.DagRunner;

/**
 * Dialog that lets the user reassign standalone objects to named clusters.
 * Shown between the TriageReviewDialog and Phase 3 generation when both
 * named clusters and standalone objects exist.
 */
public class StandaloneReassignDialog extends TitleAreaDialog {

    public static class StandaloneItem {
        public final String name;
        public final String type;
        public final String summary;
        public String assignedCluster; // "Standalone (keep)" or a cluster name

        public StandaloneItem(String name, String type, String summary) {
            this.name = name;
            this.type = type;
            this.summary = summary != null ? summary : "";
            this.assignedCluster = KEEP_STANDALONE;
        }
    }

    static final String KEEP_STANDALONE = "Standalone (keep)";

    private final List<StandaloneItem> standaloneItems;
    private final String[] clusterNames;
    private final String[] dropdownOptions; // KEEP_STANDALONE + cluster names
    private TableViewer tableViewer;
    private Label statusLabel;

    // LLM config for auto-suggest
    private final String summaryProvider;
    private final String summaryApiKey;
    private final String summaryModel;
    private final String summaryBaseUrl;
    private final List<ClusterInfo> clusterInfos;

    /** Cluster info for LLM auto-suggest. */
    public static class ClusterInfo {
        public final String name;
        public final String summary;
        public ClusterInfo(String name, String summary) {
            this.name = name;
            this.summary = summary;
        }
    }

    private Map<String, String> resultAssignments;

    public StandaloneReassignDialog(Shell parentShell,
                                     List<StandaloneItem> standaloneItems,
                                     String[] clusterNames,
                                     List<ClusterInfo> clusterInfos,
                                     String summaryProvider, String summaryApiKey,
                                     String summaryModel, String summaryBaseUrl) {
        super(parentShell);
        this.standaloneItems = standaloneItems;
        this.clusterNames = clusterNames;
        this.clusterInfos = clusterInfos;
        this.summaryProvider = summaryProvider;
        this.summaryApiKey = summaryApiKey;
        this.summaryModel = summaryModel;
        this.summaryBaseUrl = summaryBaseUrl;

        this.dropdownOptions = new String[clusterNames.length + 1];
        this.dropdownOptions[0] = KEEP_STANDALONE;
        System.arraycopy(clusterNames, 0, dropdownOptions, 1, clusterNames.length);

        setShellStyle(getShellStyle() | SWT.RESIZE | SWT.MAX);
    }

    @Override
    public void create() {
        super.create();
        setTitle("Assign Standalone Objects to Groups");
        setMessage("These objects have no internal dependencies. "
            + "You can assign them to existing groups or keep them standalone.");
        updateStatusLabel();
    }

    @Override
    protected Control createDialogArea(Composite parent) {
        Composite area = (Composite) super.createDialogArea(parent);
        Composite container = new Composite(area, SWT.NONE);
        container.setLayoutData(new GridData(SWT.FILL, SWT.FILL, true, true));
        container.setLayout(new GridLayout(1, false));

        // Table
        org.eclipse.swt.widgets.Table table = new org.eclipse.swt.widgets.Table(
            container, SWT.BORDER | SWT.FULL_SELECTION);
        table.setHeaderVisible(true);
        table.setLinesVisible(true);
        GridData tableGd = new GridData(SWT.FILL, SWT.FILL, true, true);
        tableGd.heightHint = 300;
        tableGd.widthHint = 800;
        table.setLayoutData(tableGd);

        tableViewer = new TableViewer(table);
        tableViewer.setContentProvider(ArrayContentProvider.getInstance());

        // Column: Object Name
        TableViewerColumn nameCol = new TableViewerColumn(tableViewer, SWT.NONE);
        nameCol.getColumn().setText("Object Name");
        nameCol.getColumn().setWidth(180);
        nameCol.setLabelProvider(new ColumnLabelProvider() {
            @Override
            public String getText(Object element) {
                return ((StandaloneItem) element).name;
            }
        });

        // Column: Type
        TableViewerColumn typeCol = new TableViewerColumn(tableViewer, SWT.NONE);
        typeCol.getColumn().setText("Type");
        typeCol.getColumn().setWidth(60);
        typeCol.setLabelProvider(new ColumnLabelProvider() {
            @Override
            public String getText(Object element) {
                return ((StandaloneItem) element).type;
            }
        });

        // Column: Summary
        TableViewerColumn summaryCol = new TableViewerColumn(tableViewer, SWT.NONE);
        summaryCol.getColumn().setText("Summary");
        summaryCol.getColumn().setWidth(280);
        summaryCol.setLabelProvider(new ColumnLabelProvider() {
            @Override
            public String getText(Object element) {
                return ((StandaloneItem) element).summary;
            }
        });

        // Column: Assign To (editable dropdown)
        TableViewerColumn assignCol = new TableViewerColumn(tableViewer, SWT.NONE);
        assignCol.getColumn().setText("Assign To");
        assignCol.getColumn().setWidth(200);
        assignCol.setLabelProvider(new ColumnLabelProvider() {
            @Override
            public String getText(Object element) {
                return ((StandaloneItem) element).assignedCluster;
            }
        });
        assignCol.setEditingSupport(new EditingSupport(tableViewer) {
            @Override
            protected CellEditor getCellEditor(Object element) {
                return new ComboBoxCellEditor(tableViewer.getTable(), dropdownOptions, SWT.READ_ONLY);
            }

            @Override
            protected boolean canEdit(Object element) {
                return true;
            }

            @Override
            protected Object getValue(Object element) {
                String assigned = ((StandaloneItem) element).assignedCluster;
                for (int i = 0; i < dropdownOptions.length; i++) {
                    if (dropdownOptions[i].equals(assigned)) return i;
                }
                return 0;
            }

            @Override
            protected void setValue(Object element, Object value) {
                int idx = (Integer) value;
                ((StandaloneItem) element).assignedCluster = dropdownOptions[idx];
                tableViewer.refresh();
                updateStatusLabel();
            }
        });

        tableViewer.setInput(standaloneItems);

        // Button bar
        Composite buttonBar = new Composite(container, SWT.NONE);
        buttonBar.setLayout(new GridLayout(2, false));
        buttonBar.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));

        Button autoSuggestBtn = new Button(buttonBar, SWT.PUSH);
        autoSuggestBtn.setText("Auto-suggest (LLM)");
        autoSuggestBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                runAutoSuggest();
            }
        });

        Button keepAllBtn = new Button(buttonBar, SWT.PUSH);
        keepAllBtn.setText("Keep All Standalone");
        keepAllBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                for (StandaloneItem item : standaloneItems) {
                    item.assignedCluster = KEEP_STANDALONE;
                }
                tableViewer.refresh();
                updateStatusLabel();
            }
        });

        // Status label
        statusLabel = new Label(container, SWT.NONE);
        statusLabel.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));

        return area;
    }

    private void updateStatusLabel() {
        int reassigned = 0;
        for (StandaloneItem item : standaloneItems) {
            if (!KEEP_STANDALONE.equals(item.assignedCluster)) {
                reassigned++;
            }
        }
        statusLabel.setText(reassigned + " of " + standaloneItems.size()
            + " standalone objects assigned to groups");
    }

    private void runAutoSuggest() {
        // Build JSON for standalone objects
        StringBuilder objJson = new StringBuilder("[");
        for (int i = 0; i < standaloneItems.size(); i++) {
            if (i > 0) objJson.append(",");
            StandaloneItem item = standaloneItems.get(i);
            objJson.append("{\"name\":\"").append(DagRunner.escapeJson(item.name)).append("\"");
            objJson.append(",\"type\":\"").append(DagRunner.escapeJson(item.type)).append("\"");
            objJson.append(",\"summary\":\"").append(DagRunner.escapeJson(item.summary)).append("\"}");
        }
        objJson.append("]");

        // Build JSON for clusters
        StringBuilder clJson = new StringBuilder("[");
        for (int i = 0; i < clusterInfos.size(); i++) {
            if (i > 0) clJson.append(",");
            ClusterInfo ci = clusterInfos.get(i);
            clJson.append("{\"name\":\"").append(DagRunner.escapeJson(ci.name)).append("\"");
            clJson.append(",\"summary\":\"").append(DagRunner.escapeJson(ci.summary)).append("\"}");
        }
        clJson.append("]");

        try {
            PluginConsole.println("Auto-suggesting standalone assignments via LLM...");
            DagRunner runner = new DagRunner();
            String resultJson = runner.suggestStandaloneAssignments(
                summaryProvider, summaryApiKey, summaryModel, summaryBaseUrl,
                objJson.toString(), clJson.toString(),
                line -> PluginConsole.println(line));

            // Parse result: {"assignments":{"OBJ_NAME":"CLUSTER_NAME",...}}
            Map<String, String> suggestions = parseAssignmentResult(resultJson);
            int applied = 0;
            for (StandaloneItem item : standaloneItems) {
                String suggested = suggestions.get(item.name);
                if (suggested != null) {
                    // Verify it's a valid cluster name in our dropdown
                    for (String opt : dropdownOptions) {
                        if (opt.equals(suggested)) {
                            item.assignedCluster = suggested;
                            applied++;
                            break;
                        }
                    }
                }
            }
            PluginConsole.println("Auto-suggest applied " + applied + " assignment(s).");
            tableViewer.refresh();
            updateStatusLabel();
        } catch (Exception ex) {
            PluginConsole.println("Auto-suggest failed: " + ex.getMessage());
        }
    }

    private static Map<String, String> parseAssignmentResult(String json) {
        Map<String, String> result = new HashMap<>();
        String key = "\"assignments\":{";
        int start = json.indexOf(key);
        if (start == -1) return result;
        int pos = start + key.length();

        while (pos < json.length()) {
            while (pos < json.length() && (Character.isWhitespace(json.charAt(pos)) || json.charAt(pos) == ',')) {
                pos++;
            }
            if (pos >= json.length() || json.charAt(pos) == '}') break;
            if (json.charAt(pos) != '"') break;
            pos++;

            // Extract key
            int keyEnd = json.indexOf('"', pos);
            if (keyEnd == -1) break;
            String objName = json.substring(pos, keyEnd);
            pos = keyEnd + 1;

            // Skip colon and whitespace
            while (pos < json.length() && (json.charAt(pos) == ':' || Character.isWhitespace(json.charAt(pos)))) {
                pos++;
            }

            // Extract value
            if (pos >= json.length() || json.charAt(pos) != '"') break;
            pos++;
            int valEnd = json.indexOf('"', pos);
            if (valEnd == -1) break;
            String clusterName = json.substring(pos, valEnd);
            pos = valEnd + 1;

            result.put(objName, clusterName);
        }
        return result;
    }

    @Override
    protected void okPressed() {
        resultAssignments = new HashMap<>();
        for (StandaloneItem item : standaloneItems) {
            if (!KEEP_STANDALONE.equals(item.assignedCluster)) {
                resultAssignments.put(item.name, item.assignedCluster);
            }
        }
        super.okPressed();
    }

    /** Returns map of objectName → clusterName for reassigned objects. Empty if none reassigned. */
    public Map<String, String> getReassignments() {
        return resultAssignments != null ? resultAssignments : new HashMap<>();
    }

    @Override
    protected boolean isResizable() {
        return true;
    }

    @Override
    protected Point getInitialSize() {
        return new Point(800, 500);
    }
}
