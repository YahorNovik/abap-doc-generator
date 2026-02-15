import { ADTClient, SearchResult, UsageReference, DdicElement } from "abap-adt-api";

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

  /** Known ADT URL patterns for DDIC object types. */
  private static readonly DDIC_URL_MAP: Record<string, string> = {
    TABL: "/sap/bc/adt/ddic/tables/",
    VIEW: "/sap/bc/adt/ddic/views/",
    DTEL: "/sap/bc/adt/ddic/dataelements/",
    DOMA: "/sap/bc/adt/ddic/domains/",
  };

  /**
   * Fetches the ABAP source code for a given object using the proper ADT pattern:
   * searchObject → objectStructure → mainInclude → getObjectSource
   * For DDIC objects, falls back to direct URL patterns if search fails.
   */
  async fetchSource(objectName: string, objectType?: string): Promise<string> {
    // Try standard search-based approach first
    const objectUrl = await this.resolveObjectUrl(objectName);
    if (objectUrl) {
      try {
        const structure = await this.client.objectStructure(objectUrl);
        const sourceUrl = ADTClient.mainInclude(structure);
        return await this.client.getObjectSource(sourceUrl);
      } catch {
        // Standard approach failed — try DDIC direct URL below
      }
    }

    // For DDIC types, try known URL patterns directly
    if (objectType) {
      const basePath = AdtClientWrapper.DDIC_URL_MAP[objectType];
      if (basePath) {
        const name = objectName.toLowerCase();
        // TABL/VIEW: source at /source/main
        if (objectType === "TABL" || objectType === "VIEW") {
          try {
            return await this.client.getObjectSource(`${basePath}${name}/source/main`);
          } catch { /* try object URL directly */ }
        }
        // DTEL/DOMA: read from object URL directly (returns XML)
        try {
          return await this.client.getObjectSource(`${basePath}${name}`);
        } catch { /* fall through */ }
      }
    }

    throw new Error(`Cannot fetch source for ${objectName}${objectType ? ` (${objectType})` : ""}`);
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
   * Fetches DDIC structure for objects without source code (TABL, VIEW, DTEL, etc.).
   * Returns a text representation of the field structure.
   */
  async fetchDdicStructure(objectName: string): Promise<string | undefined> {
    try {
      const element: DdicElement = await this.client.ddicElement(objectName);
      return this.formatDdicElement(element);
    } catch {
      return undefined;
    }
  }

  private formatDdicElement(element: DdicElement, indent = 0): string {
    const lines: string[] = [];
    const prefix = "  ".repeat(indent);
    const props = element.properties?.elementProps;

    let line = `${prefix}${element.name}`;
    if (props) {
      const parts: string[] = [];
      if (props.ddicDataType) parts.push(props.ddicDataType);
      if (props.ddicLength) parts.push(`length ${props.ddicLength}`);
      if (props.ddicIsKey) parts.push("KEY");
      if (props.ddicDataElement) parts.push(`DTEL: ${props.ddicDataElement}`);
      if (parts.length > 0) line += ` (${parts.join(", ")})`;
      const label = props.ddicLabelMedium || props.ddicLabelShort || props.ddicHeading;
      if (label) line += ` — ${label}`;
    }
    lines.push(line);

    for (const child of element.children ?? []) {
      lines.push(this.formatDdicElement(child, indent + 1));
    }
    return lines.join("\n");
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
   * Converts ADT search result type (e.g., "CLAS/OC") to simple type ("CLAS").
   */
  private adtTypeToAbapType(adtType: string): string {
    return adtType.split("/")[0];
  }
}
