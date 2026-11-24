import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ByTheme } from "./ui";

describe("theme-dependent wording", () => {
  it("ships both phrasings and lets CSS choose", () => {
    const html = renderToStaticMarkup(<ByTheme light="darker" dark="brighter" />);
    expect(html).toContain('class="if-light"');
    expect(html).toContain('class="if-dark"');
    expect(html).toContain("darker");
    expect(html).toContain("brighter");
  });
});
