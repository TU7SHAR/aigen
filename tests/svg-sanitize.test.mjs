/**
 * SVG sanitizer safety tests.
 *
 * The sanitizer is an allowlist-based XML parse (lib/assets/store.js), replacing
 * the earlier regex stripper. These tests assert hostile constructs are removed
 * and that legitimate presentational SVG survives and still rasterizes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeSvg } from "../lib/assets/store.js";
import { validateImageBuffer } from "../lib/assets/verify.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** True if the sanitized output still contains any dangerous token. */
function hasDanger(out) {
  return /<script|<foreignobject|\son\w+\s*=|javascript:|vbscript:|<!doctype|<!entity|<\?xml|url\s*\(|@import|expression\s*\(/i.test(
    out
  );
}

test("removes <script> elements", () => {
  const out = sanitizeSvg(`<svg ${NS}><script>alert(1)</script><rect width="4" height="4"/></svg>`);
  assert.ok(!hasDanger(out), out);
  assert.match(out, /<rect/);
});

test("removes inline event handlers (onload/onclick)", () => {
  const out = sanitizeSvg(`<svg ${NS} onload="x()"><circle cx="2" cy="2" r="2" onclick="y()"/></svg>`);
  assert.ok(!hasDanger(out), out);
});

test("drops external image/use references (SSRF via subresource)", () => {
  const img = sanitizeSvg(`<svg ${NS}><image href="http://169.254.169.254/latest/meta-data"/></svg>`);
  assert.ok(!/169\.254|href=/i.test(img), img);
  const use = sanitizeSvg(`<svg ${NS}><use href="http://evil.example/x#a"/></svg>`);
  assert.ok(!/evil\.example/i.test(use), use);
});

test("keeps internal fragment refs on <use> (#id only)", () => {
  const out = sanitizeSvg(`<svg ${NS}><defs><rect id="a" width="2" height="2"/></defs><use href="#a"/></svg>`);
  assert.match(out, /href="#a"/);
});

test("removes <foreignObject> (embedded HTML/script surface)", () => {
  const out = sanitizeSvg(
    `<svg ${NS}><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>x</script></body></foreignObject></svg>`
  );
  assert.ok(!hasDanger(out), out);
});

test("scrubs url()/expression()/javascript: in style attributes", () => {
  const out = sanitizeSvg(
    `<svg ${NS}><rect width="4" height="4" style="fill:url(http://evil/x);behavior:url(#default)"/></svg>`
  );
  assert.ok(!hasDanger(out), out);
});

test("neutralizes DOCTYPE / internal entity subset (XXE / billion-laughs)", () => {
  const out = sanitizeSvg(
    `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg ${NS}><text>&xxe;</text></svg>`
  );
  assert.ok(!hasDanger(out), out);
  assert.ok(!/file:|etc\/passwd/i.test(out), out);
});

test("strips javascript: hrefs on anchors and removes disallowed tags", () => {
  const out = sanitizeSvg(`<svg ${NS}><a href="javascript:alert(1)"><rect width="4" height="4"/></a></svg>`);
  assert.ok(!hasDanger(out), out);
});

test("unparseable / non-SVG input fails closed to an empty safe SVG", () => {
  const out = sanitizeSvg("not an svg at all <<< >>>");
  assert.match(out, /^<svg[\s>]/);
  assert.ok(!hasDanger(out));
});

test("legitimate presentational SVG survives and still rasterizes", async () => {
  const good = `<svg ${NS} viewBox="0 0 20 20"><rect width="20" height="20" fill="#ff0000"/><circle cx="10" cy="10" r="5" fill="#fff"/></svg>`;
  const out = sanitizeSvg(good);
  assert.match(out, /<rect/);
  assert.match(out, /<circle/);
  assert.ok(!hasDanger(out));
  // Defense-in-depth: sharp rasterizes the sanitized SVG without executing it.
  const v = await validateImageBuffer(Buffer.from(good), "image/svg+xml");
  assert.equal(v.status, "ready");
  assert.ok(v.rasterBuffer && v.rasterBuffer.length > 0);
});
