package com.abap.doc.plugin.chat;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.commands.ExecutionException;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.PartInitException;
import org.eclipse.ui.handlers.HandlerUtil;

public class OpenChatHandler extends AbstractHandler {

    @Override
    public Object execute(ExecutionEvent event) throws ExecutionException {
        IWorkbenchPage page = HandlerUtil.getActiveWorkbenchWindow(event).getActivePage();
        if (page != null) {
            try {
                page.showView(ChatView.ID);
            } catch (PartInitException e) {
                throw new ExecutionException("Failed to open ABAP Doc Chat view", e);
            }
        }
        return null;
    }
}
