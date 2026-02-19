import { ADTClient, SearchResult, UsageReference } from "abap-adt-api";
import { CdsDependency } from "./types";

export class AdtClientWrapper {
  private client: ADTClient;

  constructor(systemUrl: string, username: string, password: string, client: string) {
    this.client = new ADTClient(systemUrl, username, password, client);
  }

  async connect(): Promise<void> {
    await this.client.login();
  }

  async disconnect(): Promise<void> {
    await this.client.logout();
  }

  /**
   * Resolves the ADT URL for an object. Uses objectUri if provided (from package contents),
   * otherwise falls back to searchObject.
   */
  private async resolveUrl(objectName: string, objectUri?: string): Promise<string> {
    if (objectUri) return objectUri;
    const url = await this.resolveObjectUrl(objectName);
    if (!url) throw new Error(`Resource ${objectName} not found via ADT search.`);
    return url;
  }

  /**
   * Fetches object source/definition via ADT:
   * objectStructure → mainInclude → getObjectSource
   *
   * Works for all types: CLAS, PROG, TABL, VIEW, DTEL, etc.
   * For DDIC objects this returns XML definition; for code objects, ABAP source.
   * Pass objectUri (from getPackageContents) to skip the search step.
   */
  async fetchSource(objectName: string, objectUri?: string): Promise<string> {
    const objectUrl = await this.resolveUrl(objectName, objectUri);
    const structure = await this.client.objectStructure(objectUrl);
    const sourceUrl = ADTClient.mainInclude(structure);
    return this.client.getObjectSource(sourceUrl);
  }

  /**
   * Searches for an object and returns its ADT type and URI.
   */
  async resolveObjectType(objectName: string): Promise<{ type: string; uri: string } | undefined> {
    const results: SearchResult[] = await this.client.searchObject(objectName, undefined, 10);
    const match = results.find(
      (r) => r["adtcore:name"].toUpperCase() === objectName.toUpperCase()
    );
    if (!match) return undefined;
    return {
      type: this.adtTypeToAbapType(match["adtcore:type"]),
      uri: match["adtcore:uri"],
    };
  }

  /**
   * Returns the where-used list for a given ABAP object.
   */
  async getWhereUsed(objectName: string): Promise<Array<{ name: string; type: string; description: string }>> {
    const objectUrl = await this.resolveObjectUrl(objectName);
    if (!objectUrl) {
      throw new Error(`Object ${objectName} not found via ADT search.`);
    }

    const references: UsageReference[] = await this.client.usageReferences(objectUrl);
    return references
      .filter((r) => r["adtcore:name"])
      .map((r) => ({
        name: r["adtcore:name"],
        type: r["adtcore:type"] ?? "unknown",
        description: r["adtcore:description"] ?? "",
      }));
  }

  /**
   * Fetches the contents of an ABAP package (development class).
   */
  async getPackageContents(packageName: string): Promise<Array<{
    objectType: string;
    objectName: string;
    objectUri: string;
    description: string;
  }>> {
    const result = await (this.client as any).nodeContents("DEVC/K", packageName);
    return result.nodes.map((node: any) => ({
      objectType: node.OBJECT_TYPE ?? "",
      objectName: node.OBJECT_NAME ?? "",
      objectUri: node.OBJECT_URI ?? "",
      description: node.DESCRIPTION ?? "",
    }));
  }

  /**
   * Resolves the ADT URI for an object via search.
   */
  private async resolveObjectUrl(objectName: string): Promise<string | undefined> {
    const results: SearchResult[] = await this.client.searchObject(objectName, undefined, 10);
    const match = results.find(
      (r) => r["adtcore:name"].toUpperCase() === objectName.toUpperCase()
    );
    return match?.["adtcore:uri"];
  }

  /**
   * Fetches CDS view dependencies via the ADT test double framework endpoint.
   * Returns a flat list of data sources (tables, other CDS views) that the view depends on.
   */
  async getCdsDependencies(ddlsName: string): Promise<CdsDependency[]> {
    const url = `/sap/bc/adt/testcodegen/dependencies/doubledata?ddlsourceName=${encodeURIComponent(ddlsName)}`;
    const response = await this.client.httpClient.request(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.sap.adt.codegen.data.v1+xml",
      },
    });

    return parseCdsDependencyXml(response.body);
  }

  /**
   * Converts ADT search result type (e.g., "CLAS/OC") to simple type ("CLAS").
   */
  private adtTypeToAbapType(adtType: string): string {
    return adtType.split("/")[0];
  }
}

/**
 * Parses the XML response from the CDS test double dependency endpoint.
 * Extracts dependency names and types (TABLE, CDS_VIEW, VIEW).
 */
function parseCdsDependencyXml(xml: string): CdsDependency[] {
  const deps: CdsDependency[] = [];
  // Match <double double_name="..." double_type="..."/>
  const doubleRegex = /double_name="([^"]+)"\s+double_type="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = doubleRegex.exec(xml)) !== null) {
    deps.push({ name: match[1].toUpperCase(), type: match[2] });
  }
  return deps;
}
