import { describe, it, expect } from "vitest";
import { UnionFind } from "../src/union-find";

describe("UnionFind", () => {
  it("should initialize each element as its own component", () => {
    const uf = new UnionFind(["A", "B", "C"]);
    const components = uf.getComponents();
    expect(components.size).toBe(3);
  });

  it("should find returns self for isolated element", () => {
    const uf = new UnionFind(["A", "B"]);
    expect(uf.find("A")).toBe("A");
    expect(uf.find("B")).toBe("B");
  });

  it("should throw for unknown element", () => {
    const uf = new UnionFind(["A"]);
    expect(() => uf.find("X")).toThrow("Element X not in UnionFind");
  });

  it("should union two elements into one component", () => {
    const uf = new UnionFind(["A", "B", "C"]);
    uf.union("A", "B");

    expect(uf.find("A")).toBe(uf.find("B"));
    expect(uf.find("C")).not.toBe(uf.find("A"));

    const components = uf.getComponents();
    expect(components.size).toBe(2);
  });

  it("should handle transitive unions", () => {
    const uf = new UnionFind(["A", "B", "C"]);
    uf.union("A", "B");
    uf.union("B", "C");

    expect(uf.find("A")).toBe(uf.find("C"));
    const components = uf.getComponents();
    expect(components.size).toBe(1);

    const members = Array.from(components.values())[0];
    expect(members).toHaveLength(3);
    expect(members).toContain("A");
    expect(members).toContain("B");
    expect(members).toContain("C");
  });

  it("should handle multiple disjoint components", () => {
    const uf = new UnionFind(["A", "B", "C", "D", "E"]);
    uf.union("A", "B");
    uf.union("C", "D");

    const components = uf.getComponents();
    expect(components.size).toBe(3); // {A,B}, {C,D}, {E}

    expect(uf.find("A")).toBe(uf.find("B"));
    expect(uf.find("C")).toBe(uf.find("D"));
    expect(uf.find("E")).not.toBe(uf.find("A"));
    expect(uf.find("E")).not.toBe(uf.find("C"));
  });

  it("should handle union of already-connected elements", () => {
    const uf = new UnionFind(["A", "B"]);
    uf.union("A", "B");
    uf.union("A", "B"); // no-op

    const components = uf.getComponents();
    expect(components.size).toBe(1);
  });

  it("should handle single element", () => {
    const uf = new UnionFind(["A"]);
    expect(uf.find("A")).toBe("A");
    const components = uf.getComponents();
    expect(components.size).toBe(1);
  });

  it("should handle empty set", () => {
    const uf = new UnionFind([]);
    const components = uf.getComponents();
    expect(components.size).toBe(0);
  });

  it("should handle chain of unions correctly", () => {
    const uf = new UnionFind(["A", "B", "C", "D", "E"]);
    uf.union("A", "B");
    uf.union("B", "C");
    uf.union("C", "D");
    uf.union("D", "E");

    const components = uf.getComponents();
    expect(components.size).toBe(1);
    const members = Array.from(components.values())[0];
    expect(members).toHaveLength(5);
  });

  it("should merge two large components", () => {
    const uf = new UnionFind(["A", "B", "C", "D", "E", "F"]);
    // Component 1: A-B-C
    uf.union("A", "B");
    uf.union("B", "C");
    // Component 2: D-E-F
    uf.union("D", "E");
    uf.union("E", "F");

    expect(uf.getComponents().size).toBe(2);

    // Merge components
    uf.union("C", "D");
    expect(uf.getComponents().size).toBe(1);
    expect(uf.find("A")).toBe(uf.find("F"));
  });
});
