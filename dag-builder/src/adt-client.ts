import { ADTClient, SearchResult } from "abap-adt-api";
import { AbapObjectType } from "./types";

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
   * Fetches the ABAP source code for a given object.
   */
  async fetchSource(objectName: string, objectType: AbapObjectType): Promise<string> {
    const sourceUrl = this.buildSourceUrl(objectName, objectType);
    return this.client.getObjectSource(sourceUrl);
  }

  /**
   * Searches for an object and returns its type from the ADT search results.
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

  private buildSourceUrl(objectName: string, objectType: AbapObjectType): string {
    const name = objectName.toLowerCase();
    switch (objectType) {
      case "CLAS":
        return `/sap/bc/adt/oo/classes/${name}/source/main`;
      case "INTF":
        return `/sap/bc/adt/oo/interfaces/${name}/source/main`;
      case "PROG":
        return `/sap/bc/adt/programs/programs/${name}/source/main`;
      case "FUGR":
        return `/sap/bc/adt/functions/groups/${name}/source/main`;
      default:
        throw new Error(`Unsupported object type: ${objectType}`);
    }
  }

  /**
   * Converts ADT search result type (e.g., "CLAS/OC") to simple type ("CLAS").
   */
  private adtTypeToAbapType(adtType: string): string {
    return adtType.split("/")[0];
  }
}
