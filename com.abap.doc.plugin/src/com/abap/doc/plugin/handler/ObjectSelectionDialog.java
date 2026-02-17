package com.abap.doc.plugin.handler;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

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

public class ObjectSelectionDialog extends TitleAreaDialog {

    public static class PackageObjectItem {
        public final String name;
        public final String type;
        public final String description;
        public final String subPackage;
        public final String uri;

        public PackageObjectItem(String name, String type, String description, String subPackage, String uri) {
            this.name = name;
            this.type = type;
            this.description = description != null ? description : "";
            this.subPackage = subPackage != null ? subPackage : "";
            this.uri = uri != null ? uri : "";
        }
    }

    private static final Set<String> DEFAULT_INCLUDED_TYPES = new HashSet<>(Arrays.asList(
        "CLAS", "INTF", "PROG", "FUGR",
        "DDLS", "DDLX", "DCLS",
        "BDEF", "SRVD",
        "TABL", "VIEW"
    ));

    private final List<PackageObjectItem> allObjects;
    private CheckboxTableViewer tableViewer;
    private Label statusLabel;
    private Text filterText;
    private String[] excludedObjects;

    public ObjectSelectionDialog(Shell parentShell, List<PackageObjectItem> objects) {
        super(parentShell);
        this.allObjects = objects;
        setShellStyle(getShellStyle() | SWT.RESIZE | SWT.MAX);
    }

    @Override
    public void create() {
        super.create();
        setTitle("Select Objects for Documentation");
        setMessage("Check objects to include in documentation generation. "
            + "Unchecked objects will still appear in dependency diagrams.");
        applyDefaultSelection();
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
        filterText.setMessage("Filter by name or type...");
        filterText.addModifyListener(e -> tableViewer.refresh());

        // Checkbox table
        org.eclipse.swt.widgets.Table table = new org.eclipse.swt.widgets.Table(
            container, SWT.CHECK | SWT.BORDER | SWT.FULL_SELECTION | SWT.MULTI);
        table.setHeaderVisible(true);
        table.setLinesVisible(true);
        GridData tableGd = new GridData(SWT.FILL, SWT.FILL, true, true);
        tableGd.heightHint = 350;
        tableGd.widthHint = 650;
        table.setLayoutData(tableGd);

        tableViewer = new CheckboxTableViewer(table);
        tableViewer.setContentProvider(ArrayContentProvider.getInstance());

        createColumn("Object Name", 220, 0);
        createColumn("Type", 60, 1);
        createColumn("Description", 250, 2);
        createColumn("Sub-Package", 120, 3);

        tableViewer.setInput(allObjects);

        // Filter
        tableViewer.addFilter(new ViewerFilter() {
            @Override
            public boolean select(Viewer viewer, Object parentElement, Object element) {
                String text = filterText.getText().trim().toUpperCase();
                if (text.isEmpty()) return true;
                PackageObjectItem item = (PackageObjectItem) element;
                return item.name.toUpperCase().contains(text)
                    || item.type.toUpperCase().contains(text)
                    || item.description.toUpperCase().contains(text)
                    || item.subPackage.toUpperCase().contains(text);
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
        buttonBar.setLayout(new GridLayout(3, false));
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

        Button resetDefaultsBtn = new Button(buttonBar, SWT.PUSH);
        resetDefaultsBtn.setText("Reset Defaults");
        resetDefaultsBtn.addSelectionListener(new SelectionAdapter() {
            @Override
            public void widgetSelected(SelectionEvent e) {
                applyDefaultSelection();
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
                PackageObjectItem item = (PackageObjectItem) element;
                switch (colIndex) {
                    case 0: return item.name;
                    case 1: return item.type;
                    case 2: return item.description;
                    case 3: return item.subPackage;
                    default: return "";
                }
            }
        });
    }

    private void applyDefaultSelection() {
        for (PackageObjectItem item : allObjects) {
            tableViewer.setChecked(item, DEFAULT_INCLUDED_TYPES.contains(item.type));
        }
    }

    private void updateStatusLabel() {
        int checked = tableViewer.getCheckedElements().length;
        int total = allObjects.size();
        statusLabel.setText(checked + " of " + total + " objects selected for documentation");
    }

    @Override
    protected void okPressed() {
        Set<String> checkedNames = new HashSet<>();
        for (Object checked : tableViewer.getCheckedElements()) {
            checkedNames.add(((PackageObjectItem) checked).name);
        }
        List<String> excluded = new ArrayList<>();
        for (PackageObjectItem item : allObjects) {
            if (!checkedNames.contains(item.name)) {
                excluded.add(item.name);
            }
        }
        this.excludedObjects = excluded.toArray(new String[0]);
        super.okPressed();
    }

    public String[] getExcludedObjects() {
        return excludedObjects;
    }

    @Override
    protected boolean isResizable() {
        return true;
    }

    @Override
    protected Point getInitialSize() {
        return new Point(700, 500);
    }

    private static class ColumnComparator extends ViewerComparator {
        private final int columnIndex;

        ColumnComparator(int columnIndex) {
            this.columnIndex = columnIndex;
        }

        @Override
        public int compare(Viewer viewer, Object e1, Object e2) {
            PackageObjectItem i1 = (PackageObjectItem) e1;
            PackageObjectItem i2 = (PackageObjectItem) e2;
            switch (columnIndex) {
                case 0: return i1.name.compareTo(i2.name);
                case 1: return i1.type.compareTo(i2.type);
                case 2: return i1.description.compareTo(i2.description);
                case 3: return i1.subPackage.compareTo(i2.subPackage);
                default: return 0;
            }
        }
    }
}
