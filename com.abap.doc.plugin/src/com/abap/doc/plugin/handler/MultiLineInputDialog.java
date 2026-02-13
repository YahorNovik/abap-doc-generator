package com.abap.doc.plugin.handler;

import org.eclipse.jface.dialogs.TitleAreaDialog;
import org.eclipse.swt.SWT;
import org.eclipse.swt.layout.GridData;
import org.eclipse.swt.layout.GridLayout;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.swt.widgets.Control;
import org.eclipse.swt.widgets.Shell;
import org.eclipse.swt.widgets.Text;

public class MultiLineInputDialog extends TitleAreaDialog {

    private final String dialogTitle;
    private final String dialogMessage;
    private final String initialValue;
    private String value = "";
    private Text textWidget;

    public MultiLineInputDialog(Shell parentShell, String title, String message, String initialValue) {
        super(parentShell);
        this.dialogTitle = title;
        this.dialogMessage = message;
        this.initialValue = initialValue != null ? initialValue : "";
    }

    @Override
    public void create() {
        super.create();
        setTitle(dialogTitle);
        setMessage(dialogMessage);
    }

    @Override
    protected Control createDialogArea(Composite parent) {
        Composite area = (Composite) super.createDialogArea(parent);
        Composite container = new Composite(area, SWT.NONE);
        container.setLayoutData(new GridData(SWT.FILL, SWT.FILL, true, true));
        container.setLayout(new GridLayout(1, false));

        textWidget = new Text(container, SWT.MULTI | SWT.BORDER | SWT.WRAP | SWT.V_SCROLL);
        GridData gd = new GridData(SWT.FILL, SWT.FILL, true, true);
        gd.heightHint = 150;
        gd.widthHint = 500;
        textWidget.setLayoutData(gd);
        textWidget.setText(initialValue);

        return area;
    }

    @Override
    protected void okPressed() {
        value = textWidget.getText();
        super.okPressed();
    }

    public String getValue() {
        return value;
    }

    @Override
    protected boolean isResizable() {
        return true;
    }
}
