import { describe, expect, it } from "vitest";
import { renderBody } from "../src/lib/forum";

describe("renderBody", () => {
  it("convierte párrafos y énfasis simple, y escapa HTML", () => {
    const html = renderBody("Primer *párrafo* con **fuerza**.\nSigue.\n\n<script>alert(1)</script> y 2*3*4");
    expect(html).toBe('<p>Primer <em>párrafo</em> con <strong>fuerza</strong>.<br>Sigue.</p>\n<p>&lt;script&gt;alert(1)&lt;/script&gt; y 2*3*4</p>');
  });

  it("no interpreta encabezados ni listas markdown", () => {
    expect(renderBody("# Título\n- item")).toBe("<p># Título<br>- item</p>");
  });
});
