import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/** The icon shows the destination, so the pairing of glyph and label matters. */
describe("theme toggle", () => {
  it("offers dark, as a moon, while light is on screen", async () => {
    vi.resetModules();
    const { default: ThemeToggle } = await import("./ThemeToggle");
    const html = renderToStaticMarkup(<ThemeToggle />);
    expect(html).toContain('aria-label="Switch to dark mode"');
    expect(html).toContain('title="Switch to dark mode"');
    // the glyph is decorative: the label carries the meaning, not the shape
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<path");
    expect(html).not.toContain("<circle"); // the sun's disc
  });

  it("offers light, as a sun, when the OS is already dark", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    const { default: ThemeToggle } = await import("./ThemeToggle");
    const html = renderToStaticMarkup(<ThemeToggle />);
    // following a dark OS, the first click has to go to light
    expect(html).toContain('aria-label="Switch to light mode"');
    expect(html).toContain("<circle");
    vi.unstubAllGlobals();
  });

  it("is a button, not a select", async () => {
    vi.resetModules();
    const { default: ThemeToggle } = await import("./ThemeToggle");
    const html = renderToStaticMarkup(<ThemeToggle />);
    expect(html).toContain("<button");
    expect(html).toContain("icon-btn");
    expect(html).not.toContain("<select");
  });
});
