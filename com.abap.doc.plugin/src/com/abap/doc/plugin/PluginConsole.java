package com.abap.doc.plugin;

import java.io.IOException;

import org.eclipse.ui.console.ConsolePlugin;
import org.eclipse.ui.console.IConsole;
import org.eclipse.ui.console.IConsoleManager;
import org.eclipse.ui.console.MessageConsole;
import org.eclipse.ui.console.MessageConsoleStream;

public class PluginConsole {

    private static final String CONSOLE_NAME = "ABAP Doc Generator";
    private static MessageConsole console;

    public static synchronized MessageConsole getConsole() {
        if (console == null) {
            console = new MessageConsole(CONSOLE_NAME, null);
            ConsolePlugin.getDefault().getConsoleManager().addConsoles(new IConsole[] { console });
        }
        return console;
    }

    public static void clear() {
        getConsole().clearConsole();
    }

    public static void show() {
        IConsoleManager manager = ConsolePlugin.getDefault().getConsoleManager();
        manager.showConsoleView(getConsole());
    }

    public static void println(String message) {
        try (MessageConsoleStream stream = getConsole().newMessageStream()) {
            stream.println(message);
        } catch (IOException e) {
            // ignore
        }
    }
}
