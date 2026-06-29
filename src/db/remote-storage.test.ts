import { describe, expect, test } from "bun:test";
import { shouldUsePgSsl } from "./remote-storage.js";

describe("remote storage TLS", () => {
  test("uses normal pg SSL verification without custom insecure overrides", () => {
    expect(shouldUsePgSsl("postgres://user@example.test/projects")).toBe(false);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?sslmode=require")).toBe(true);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?sslmode=verify-ca")).toBe(true);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?sslmode=verify-full")).toBe(true);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?ssl=true")).toBe(true);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?ssl=1")).toBe(true);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?ssl=yes")).toBe(true);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?ssl=on")).toBe(true);
  });

  test("does not enable SSL from unrelated or partial parameter values", () => {
    expect(shouldUsePgSsl("postgres://user@example.test/projects?sslmode=disable")).toBe(false);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?sslmode=prefer")).toBe(false);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?ssl=false")).toBe(false);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?ssl=trueish")).toBe(false);
    expect(shouldUsePgSsl("postgres://user@example.test/projects?x=sslmode=require")).toBe(false);
  });
});
