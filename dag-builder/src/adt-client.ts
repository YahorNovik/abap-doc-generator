import { ADTClient, SearchResult } from "abap-adt-api";

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
   * Fetches the ABAP source code for a given object using the proper ADT pattern:
   * searchObject → objectStructure → mainInclude → getObjectSource
   */
  async fetchSource(objectName: string): Promise<string> {
    const objectUrl = await this.resolveObjectUrl(objectName);
    if (!objectUrl) {
      throw new Error(`Resource ${objectName} not found via ADT search.`);
    }

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
