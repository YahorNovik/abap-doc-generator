package com.abap.doc.plugin.handler;

import java.util.ArrayList;
import java.util.List;

import org.eclipse.jface.dialogs.TitleAreaDialog;
import org.eclipse.jface.viewers.ArrayContentProvider;
import org.eclipse.jface.viewers.CheckboxTableViewer;
import org.eclipse.jface.viewers.ColumnLabelProvider;
import org.eclipse.jface.viewers.TableViewerColumn;
import org.eclipse.jface.viewers.Viewer;
import org.eclipse.jface.viewers.ViewerComparator;
import org.eclipse.jface.viewers.ViewerFilter;
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
import org.eclipse.swt.widgets.Text;

public class TriageReviewDialog extends TitleAreaDialog {

    public static class TriageObjectItem {
        public final String name;
        public final String type;
        public final String summary;
        public final int sourceLines;
        public final int depCount;
        public final int usedByCount;
        public final boolean llmSelected;
        public final String subPackage;
        public final String clusterName;

        public TriageObjectItem(String name, String type, String summary,
                                int sourceLines, int depCount, int usedByCount,
                                boolean llmSelected, String subPackage, String clusterName) {
            this.name = name;
            this.type = type;
            this.summary = summary != null ? summary : "";
            this.sourceLines = sourceLines;
            this.depCount = depCount;
            this.usedByCount = usedByCount;
            this.llmSelected = llmSelected;
            this.subPackage = subPackage != null ? subPackage : "";
            this.clusterName = clusterName != null ? clusterName : "";
        }
    }

    private final List<TriageObjectItem> allObjects;
    private CheckboxTableViewer tableViewer;
    private Label statusLabel;
    private Text filterText;
    private String[] fullDocObjects;

    public TriageReviewDialog(Shell parentShell, List<TriageObjectItem> objects) {
        super(parentShell);
        this.allObjects = objects;
        setShellStyle(getShellStyle() | SWT.RESIZE | SWT.MAX);
    }

    @Override
    public void create() {
        super.create();
        setTitle("Review Documentation Scope");
        setMessage("Objects checked below will receive full documentation. "
            + "Unchecked objects will have summary-only pages.");
        applyLlmSelection();
        updateStatusLabel();
    }

    @Override
    protected Control createDialogArea(Composite parent) {
        Composite area = (Composite) super.createDialogArea(parent);
        Composite container = new Composite(area, SWT.NONE);
        container.setLayoutData(new GridData(SWT.FILL, SWT.FILL, true, true));
        container.setLayout(new GridLayout(1, false));

        // Filter text box
        filterText = new Text(container, SWT.BORDER | SWT.SEARCH);
        filterText.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        filterText.setMessage("Filter by name, type, or summary...");
        filterText.addModifyListener(e -> tableViewer.refresh());

        // Checkbox table
        org.eclipse.swt.widgets.Table table = new org.eclipse.swt.widgets.Table(
            container, SWT.CHECK | SWT.BORDER | SWT.FULL_SELECTION | SWT.MULTI);
        table.setHeaderVisible(true);
        table.setLinesVisible(true);
        GridData tableGd = new GridData(SWT.FILL, SWT.FILL, true, true);
        tableGd.heightHint = 350;
        tableGd.widthHint = 750;
        table.setLayoutData(tableGd);

        tableViewer = new CheckboxTableViewer(table);
        tableViewer.setContentProvider(ArrayContentProvider.getInstance());

        createColumn("Object Name", 200, 0);
        createColumn("Type", 60, 1);
        createColumn("Summary", 280, 2);
        createColumn("Lines", 60, 3);
        createColumn("Deps", 50, 4);

        tableViewer.setInput(allObjects);

        // Filter
        tableViewer.addFilter(new ViewerFilter() {
            @Override
            public boolean select(Viewer viewer, Object parentElement, Object element) {
                String text = filterText.getText().trim().toUpperCase();
                if (text.isEmpty()) return true;
                TriageObjectItem item = (TriageObjectItem) element;
                return item.name.toUpperCase().contains(text)
                    || item.type.toUpperCase().contains(text)
                    || item.summary.toUpperCase().contains(text)
                    || item.clusterName.toUpperCase().contains(text);
            }
        });

        // Sortable column headers
        for (int i = 0; i < table.getColumnCount(); i++) {
            final int colIndex = i;
            table.getColumn(i).addSelectionListener(new SelectionAdapter() {
                @Override
                public void widgetSelected(SelectionEvent e) {
                    tableViewer.setComparator(new ColumnComparator(colIndex));
                    tableViewer.refresh();
                }
            });
        }

        tableViewer.addCheckStateListener(event -> updateStatusLabel());

        // Button bar
        Composite buttonBar = new Composite(container, SWT.NONE);
        buttonBar.setLayout(new GridLayout(2, false));
        buttonBar.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));

        Button selectAllBtn = new Button(buttonBar, SWT.PUSH);
        selectAllBtn.setText("Select All");
        selectAllBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                tableViewer.setAllChecked(true);
                updateStatusLabel();
            }
        });

        Button deselectAllBtn = new Button(buttonBar, SWT.PUSH);
        deselectAllBtn.setText("Deselect All");
        deselectAllBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                tableViewer.setAllChecked(false);
                updateStatusLabel();
            }
        });

        // Status label
        statusLabel = new Label(container, SWT.NONE);
        statusLabel.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));

        return area;
    }

    private void createColumn(String title, int width, int colIndex) {
        TableViewerColumn col = new TableViewerColumn(tableViewer, SWT.NONE);
        col.getColumn().setText(title);
        col.getColumn().setWidth(width);
        col.setLabelProvider(new ColumnLabelProvider() {
            @Override
            public String getText(Object element) {
                TriageObjectItem item = (TriageObjectItem) element;
                switch (colIndex) {
                    case 0: return item.name;
                    case 1: return item.type;
                    case 2: return item.summary;
                    case 3: return String.valueOf(item.sourceLines);
                    case 4: return String.valueOf(item.depCount);
                    default: return "";
                }
            }
        });
    }

    private void applyLlmSelection() {
        for (TriageObjectItem item : allObjects) {
            tableViewer.setChecked(item, item.llmSelected);
        }
    }

    private void updateStatusLabel() {
        int checked = tableViewer.getCheckedElements().length;
        int total = allObjects.size();
        statusLabel.setText(checked + " of " + total + " objects selected for full documentation");
    }

    @Override
    protected void okPressed() {
        List<String> selected = new ArrayList<>();
        for (Object checked : tableViewer.getCheckedElements()) {
            selected.add(((TriageObjectItem) checked).name);
        }
        this.fullDocObjects = selected.toArray(new String[0]);
        super.okPressed();
    }

    public String[] getFullDocObjects() {
        return fullDocObjects;
    }

    @Override
    protected boolean isResizable() {
        return true;
    }

    @Override
    protected Point getInitialSize() {
        return new Point(750, 550);
    }

    private static class ColumnComparator extends ViewerComparator {
        private final int columnIndex;

        ColumnComparator(int columnIndex) {
            this.columnIndex = columnIndex;
        }

        @Override
        public int compare(Viewer viewer, Object e1, Object e2) {
            TriageObjectItem i1 = (TriageObjectItem) e1;
            TriageObjectItem i2 = (TriageObjectItem) e2;
            switch (columnIndex) {
                case 0: return i1.name.compareTo(i2.name);
                case 1: return i1.type.compareTo(i2.type);
                case 2: return i1.summary.compareTo(i2.summary);
                case 3: return Integer.compare(i1.sourceLines, i2.sourceLines);
                case 4: return Integer.compare(i1.depCount, i2.depCount);
                default: return 0;
            }
        }
    }
}
