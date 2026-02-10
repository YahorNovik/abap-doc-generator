/**
 * Determines if an ABAP object is custom (Z/Y namespace) or standard SAP.
 */
export function isCustomObject(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith("Z") || upper.startsWith("Y");
}

/**
 * Maps an ADT object type string to the abapGit file extension.
 */
export function objectTypeToFileExtension(objectType: string): string {
  switch (objectType.toUpperCase()) {
    case "CLAS":
      return "clas";
    case "INTF":
      return "intf";
    case "PROG":
      return "prog";
    case "FUGR":
      return "fugr";
    default:
      return objectType.toLowerCase();
  }
}

/**
 * Builds an abapGit-style filename for an ABAP object.
 * e.g., ZCL_MY_CLASS -> zcl_my_class.clas.abap
 */
export function buildAbapGitFilename(objectName: string, objectType: string): string {
  const ext = objectTypeToFileExtension(objectType);
  return `${objectName.toLowerCase()}.${ext}.abap`;
}
