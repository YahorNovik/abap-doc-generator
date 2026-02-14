package com.abap.doc.plugin.confluence;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Minimal Confluence REST API client using java.net.http.HttpClient.
 * Supports creating and updating pages via the Confluence REST API.
 */
public class ConfluenceClient {

    private final String baseUrl;
    private final String authHeader;
    private final HttpClient httpClient;

    public ConfluenceClient(String baseUrl, String username, String token) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        String credentials = username + ":" + token;
        this.authHeader = "Basic " + Base64.getEncoder().encodeToString(
            credentials.getBytes(StandardCharsets.UTF_8));
        this.httpClient = HttpClient.newHttpClient();
    }

    /**
     * Creates or updates a page in the given space.
     * If a page with the same title exists, it updates it; otherwise creates a new one.
     * Returns the page URL.
     */
    public String publishPage(String spaceKey, String title, String htmlBody, String parentId)
            throws IOException, InterruptedException {
        String existingPageId = findPageByTitle(spaceKey, title);

        if (existingPageId != null) {
            int currentVersion = getPageVersion(existingPageId);
            return updatePage(existingPageId, title, htmlBody, currentVersion + 1);
        } else {
            return createPage(spaceKey, title, htmlBody, parentId);
        }
    }

    /** Finds a page by title in a space. Returns page ID or null. */
    public String findPageByTitle(String spaceKey, String title)
            throws IOException, InterruptedException {
        String url = baseUrl + "/rest/api/content"
            + "?spaceKey=" + encode(spaceKey)
            + "&title=" + encode(title)
            + "&limit=1";

        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", authHeader)
            .header("Accept", "application/json")
            .GET()
            .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) return null;

        // Simple JSON extraction: look for "id":"..."
        String body = response.body();
        int resultsIdx = body.indexOf("\"results\":[");
        if (resultsIdx == -1) return null;

        int idIdx = body.indexOf("\"id\":\"", resultsIdx);
        if (idIdx == -1) return null;
        idIdx += 6;
        int idEnd = body.indexOf("\"", idIdx);
        if (idEnd == -1) return null;

        return body.substring(idIdx, idEnd);
    }

    /** Gets the current version number of a page. */
    private int getPageVersion(String pageId) throws IOException, InterruptedException {
        String url = baseUrl + "/rest/api/content/" + pageId + "?expand=version";

        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", authHeader)
            .header("Accept", "application/json")
            .GET()
            .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("Failed to get page version: HTTP " + response.statusCode());
        }

        // Extract version number
        String body = response.body();
        int vIdx = body.indexOf("\"number\":");
        if (vIdx == -1) return 1;
        vIdx += 9;
        StringBuilder digits = new StringBuilder();
        for (int i = vIdx; i < body.length(); i++) {
            char c = body.charAt(i);
            if (Character.isDigit(c)) digits.append(c);
            else if (digits.length() > 0) break;
        }
        return digits.length() > 0 ? Integer.parseInt(digits.toString()) : 1;
    }

    /** Creates a new page. Returns the page URL. */
    private String createPage(String spaceKey, String title, String htmlBody, String parentId)
            throws IOException, InterruptedException {
        String escapedTitle = jsonEscape(title);
        String escapedBody = jsonEscape(convertToStorageFormat(htmlBody));

        StringBuilder json = new StringBuilder();
        json.append("{\"type\":\"page\"");
        json.append(",\"title\":\"").append(escapedTitle).append("\"");
        json.append(",\"space\":{\"key\":\"").append(jsonEscape(spaceKey)).append("\"}");
        if (parentId != null && !parentId.isBlank()) {
            json.append(",\"ancestors\":[{\"id\":\"").append(jsonEscape(parentId)).append("\"}]");
        }
        json.append(",\"body\":{\"storage\":{\"value\":\"").append(escapedBody).append("\"");
        json.append(",\"representation\":\"storage\"}}");
        json.append("}");

        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(baseUrl + "/rest/api/content"))
            .header("Authorization", authHeader)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(json.toString()))
            .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200 && response.statusCode() != 201) {
            throw new IOException("Failed to create page: HTTP " + response.statusCode()
                + "\n" + response.body());
        }

        return extractPageUrl(response.body());
    }

    /** Updates an existing page. Returns the page URL. */
    private String updatePage(String pageId, String title, String htmlBody, int newVersion)
            throws IOException, InterruptedException {
        String escapedTitle = jsonEscape(title);
        String escapedBody = jsonEscape(convertToStorageFormat(htmlBody));

        StringBuilder json = new StringBuilder();
        json.append("{\"type\":\"page\"");
        json.append(",\"title\":\"").append(escapedTitle).append("\"");
        json.append(",\"version\":{\"number\":").append(newVersion).append("}");
        json.append(",\"body\":{\"storage\":{\"value\":\"").append(escapedBody).append("\"");
        json.append(",\"representation\":\"storage\"}}");
        json.append("}");

        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(baseUrl + "/rest/api/content/" + pageId))
            .header("Authorization", authHeader)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .PUT(HttpRequest.BodyPublishers.ofString(json.toString()))
            .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("Failed to update page: HTTP " + response.statusCode()
                + "\n" + response.body());
        }

        return extractPageUrl(response.body());
    }

    /** Converts HTML to Confluence storage format (self-close void tags). */
    private static String convertToStorageFormat(String html) {
        // Self-close void HTML tags for XHTML compliance
        return html
            .replaceAll("<(br|hr|img|input|meta|link)(\\s[^>]*)?>", "<$1$2/>")
            .replaceAll("</(br|hr|img|input|meta|link)>", "");
    }

    /** Extracts the page URL from the API response. */
    private String extractPageUrl(String responseBody) {
        // Look for _links.webui
        int webuiIdx = responseBody.indexOf("\"webui\":\"");
        if (webuiIdx != -1) {
            webuiIdx += 9;
            int end = responseBody.indexOf("\"", webuiIdx);
            if (end != -1) {
                return baseUrl + responseBody.substring(webuiIdx, end);
            }
        }
        return baseUrl;
    }

    private static String jsonEscape(String s) {
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }

    private static String encode(String s) {
        return java.net.URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}
