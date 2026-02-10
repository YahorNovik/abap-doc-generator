import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { extractDependencies } from "../src/abap-parser";

function readFixture(filename: string): string {
  return readFileSync(join(__dirname, "fixtures", filename), "utf-8");
}

describe("extractDependencies", () => {
  it("should extract custom and standard class dependencies from zcl_example", () => {
    const source = readFixture("zcl_example.clas.abap");
    const deps = extractDependencies(source, "ZCL_EXAMPLE", "CLAS");

    const depNames = deps.map((d) => d.objectName);

    // Should find custom dependencies
    expect(depNames).toContain("ZCL_CUSTOM_HELPER");
    expect(depNames).toContain("ZCL_UTILS");

    // Should find standard dependency
    expect(depNames).toContain("CL_STANDARD_LOGGER");
  });

  it("should extract method-level references", () => {
    const source = readFixture("zcl_example.clas.abap");
    const deps = extractDependencies(source, "ZCL_EXAMPLE", "CLAS");

    const utilsDep = deps.find((d) => d.objectName === "ZCL_UTILS");
    expect(utilsDep).toBeDefined();

    const methodRefs = utilsDep!.members.filter((m) => m.memberType === "method");
    const methodNames = methodRefs.map((m) => m.memberName.toUpperCase());
    expect(methodNames).toContain("CONVERT");
  });

  it("should extract interface dependencies", () => {
    const source = readFixture("zcl_with_interface.clas.abap");
    const deps = extractDependencies(source, "ZCL_WITH_INTERFACE", "CLAS");

    const depNames = deps.map((d) => d.objectName);
    expect(depNames).toContain("ZIF_PROCESSOR");
    expect(depNames).toContain("ZCL_DEPENDENCY");
    expect(depNames).toContain("ZCL_STATIC_HELPER");
  });

  it("should return empty array for class with no external dependencies", () => {
    const source = readFixture("zcl_simple.clas.abap");
    const deps = extractDependencies(source, "ZCL_SIMPLE", "CLAS");

    expect(deps).toHaveLength(0);
  });

  it("should not include self-references", () => {
    const source = readFixture("zcl_example.clas.abap");
    const deps = extractDependencies(source, "ZCL_EXAMPLE", "CLAS");

    const depNames = deps.map((d) => d.objectName);
    expect(depNames).not.toContain("ZCL_EXAMPLE");
  });
});
