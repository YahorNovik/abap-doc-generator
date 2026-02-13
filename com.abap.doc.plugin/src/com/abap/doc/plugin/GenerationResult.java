package com.abap.doc.plugin;

import java.io.File;
import java.util.Map;

/**
 * Holds the result of the most recent documentation generation.
 * Singleton updated by GenerateDocHandler / GeneratePackageDocHandler.
 * Read by ChatView and SaveDocHandler.
 */
public class GenerationResult {

    private static GenerationResult instance;

    // Generation metadata
    private String objectName;
    private String objectType;
    private boolean isPackage;

    // Single-object doc
    private String markdown;
    private String html;
    private File htmlFile;

    // Package doc
    private Map<String, String> pages;
    private File pagesDirectory;

    // SAP connection (needed for chat)
    private String systemUrl;
    private String client;
    private String username;
    private String password;

    // Doc LLM config (needed for chat)
    private String docProvider;
    private String docApiKey;
    private String docModel;
    private String docBaseUrl;
    private int maxTotalTokens;

    // User-provided context
    private String userContext;

    private GenerationResult() {}

    public static synchronized GenerationResult getInstance() {
        if (instance == null) {
            instance = new GenerationResult();
        }
        return instance;
    }

    public synchronized void clear() {
        objectName = null;
        objectType = null;
        isPackage = false;
        markdown = null;
        html = null;
        htmlFile = null;
        pages = null;
        pagesDirectory = null;
        systemUrl = null;
        client = null;
        username = null;
        password = null;
        docProvider = null;
        docApiKey = null;
        docModel = null;
        docBaseUrl = null;
        maxTotalTokens = 0;
        userContext = null;
    }

    public synchronized boolean hasResult() {
        return html != null || pages != null;
    }

    // --- Getters and setters ---

    public String getObjectName() { return objectName; }
    public void setObjectName(String objectName) { this.objectName = objectName; }

    public String getObjectType() { return objectType; }
    public void setObjectType(String objectType) { this.objectType = objectType; }

    public boolean isPackage() { return isPackage; }
    public void setPackage(boolean isPackage) { this.isPackage = isPackage; }

    public String getMarkdown() { return markdown; }
    public void setMarkdown(String markdown) { this.markdown = markdown; }

    public String getHtml() { return html; }
    public void setHtml(String html) { this.html = html; }

    public File getHtmlFile() { return htmlFile; }
    public void setHtmlFile(File htmlFile) { this.htmlFile = htmlFile; }

    public Map<String, String> getPages() { return pages; }
    public void setPages(Map<String, String> pages) { this.pages = pages; }

    public File getPagesDirectory() { return pagesDirectory; }
    public void setPagesDirectory(File pagesDirectory) { this.pagesDirectory = pagesDirectory; }

    public String getSystemUrl() { return systemUrl; }
    public void setSystemUrl(String systemUrl) { this.systemUrl = systemUrl; }

    public String getClient() { return client; }
    public void setClient(String client) { this.client = client; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }

    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }

    public String getDocProvider() { return docProvider; }
    public void setDocProvider(String docProvider) { this.docProvider = docProvider; }

    public String getDocApiKey() { return docApiKey; }
    public void setDocApiKey(String docApiKey) { this.docApiKey = docApiKey; }

    public String getDocModel() { return docModel; }
    public void setDocModel(String docModel) { this.docModel = docModel; }

    public String getDocBaseUrl() { return docBaseUrl; }
    public void setDocBaseUrl(String docBaseUrl) { this.docBaseUrl = docBaseUrl; }

    public int getMaxTotalTokens() { return maxTotalTokens; }
    public void setMaxTotalTokens(int maxTotalTokens) { this.maxTotalTokens = maxTotalTokens; }

    public String getUserContext() { return userContext; }
    public void setUserContext(String userContext) { this.userContext = userContext; }
}
