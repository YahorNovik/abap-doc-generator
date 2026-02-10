import { describe, it, expect } from "vitest";
import { isCustomObject, buildAbapGitFilename } from "../src/classifier";

describe("isCustomObject", () => {
  it("should identify Z-prefixed objects as custom", () => {
    expect(isCustomObject("ZCL_MY_CLASS")).toBe(true);
    expect(isCustomObject("zcl_my_class")).toBe(true);
    expect(isCustomObject("ZTABLE")).toBe(true);
  });

  it("should identify Y-prefixed objects as custom", () => {
    expect(isCustomObject("YCL_MY_CLASS")).toBe(true);
    expect(isCustomObject("ycl_my_class")).toBe(true);
  });

  it("should identify standard objects as non-custom", () => {
    expect(isCustomObject("CL_ABAP_TYPEDESCR")).toBe(false);
    expect(isCustomObject("CL_HTTP_CLIENT")).toBe(false);
    expect(isCustomObject("IF_HTTP_RESPONSE")).toBe(false);
    expect(isCustomObject("SFLIGHT")).toBe(false);
  });
});

describe("buildAbapGitFilename", () => {
  it("should build correct filename for class", () => {
    expect(buildAbapGitFilename("ZCL_MY_CLASS", "CLAS")).toBe("zcl_my_class.clas.abap");
  });

  it("should build correct filename for interface", () => {
    expect(buildAbapGitFilename("ZIF_MY_INTF", "INTF")).toBe("zif_my_intf.intf.abap");
  });

  it("should build correct filename for program", () => {
    expect(buildAbapGitFilename("ZREPORT", "PROG")).toBe("zreport.prog.abap");
  });
});
