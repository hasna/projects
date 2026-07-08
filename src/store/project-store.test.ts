import { describe, expect, test } from "bun:test";
import { resolveProjectStore, __resetProjectStore } from "./project-store.js";

describe("projects store resolution (client-flip)", () => {
  test("no env -> local store", () => {
    __resetProjectStore();
    const store = resolveProjectStore({});
    expect(store.mode).toBe("local");
    expect(store.baseUrl).toBeNull();
  });

  test("self_hosted + url + key -> api store", () => {
    __resetProjectStore();
    const store = resolveProjectStore({
      HASNA_PROJECTS_STORAGE_MODE: "self_hosted",
      HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
      HASNA_PROJECTS_API_KEY: "k",
    });
    expect(store.mode).toBe("api");
    expect(store.baseUrl).toBe("https://projects.hasna.xyz/v1");
  });

  // Regression: the fleet flip writes ONLY HASNA_PROJECTS_API_URL +
  // HASNA_PROJECTS_API_KEY (no STORAGE_MODE). Their joint presence must route to
  // the api store, otherwise a flipped CLI silently keeps reading local sqlite.
  test("url + key (no explicit mode) -> api store", () => {
    __resetProjectStore();
    const store = resolveProjectStore({
      HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
      HASNA_PROJECTS_API_KEY: "k",
    });
    expect(store.mode).toBe("api");
  });

  test("cloud requested but no key -> throws (never silently local)", () => {
    __resetProjectStore();
    expect(() => resolveProjectStore({ HASNA_PROJECTS_STORAGE_MODE: "self_hosted" })).toThrow();
  });

  test("cloud alias 'cloud' -> api store", () => {
    __resetProjectStore();
    const store = resolveProjectStore({
      HASNA_PROJECTS_STORAGE_MODE: "cloud",
      HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
      HASNA_PROJECTS_API_KEY: "k",
    });
    expect(store.mode).toBe("api");
  });

  test("baseUrl never embeds the api key", () => {
    __resetProjectStore();
    const store = resolveProjectStore({
      HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
      HASNA_PROJECTS_API_KEY: "super-secret-key",
    });
    expect(store.baseUrl).not.toContain("super-secret-key");
  });
});
