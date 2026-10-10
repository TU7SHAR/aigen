# Creative pipeline — architecture

_Last updated: 2026-10-09_

Replaces the old `image → one-line prompt → video` path with a deliberate,
brand-aware plan. This is the fix for low-quality output (e.g. a static poster
becoming "poster on a phone with a generic silver background").

## Pipeline

```
ProductProfile + BrandProfile + User Intent + Template + Source-image class
        │
Creative Strategist (lib/creative/planner.js)
        ▼
CreativeBrief   { objective, audience, adAngle, brand{...}, visualStyle,
        │         lighting, environment, cameraLanguage, pacing,
        ▼         productHeroMoment, ending, sourceImageHandling }
ScenePlan       { scenes:[{purpose, visual, camera, motion, lighting, duration}] }
        │
Prompt Composer (lib/creative/promptComposer.js) → professional prompt + negatives
        ▼
Video Generation (lib/ai, Gemini Omni Flash)
        ▼
[next milestone] Remotion brand/text composition
```

The video model still takes a single prompt, but the prompt is **composed from
the internal plan**, not a static sentence.

## Source-image understanding (the key fix)

`lib/creative/sourceImage.js` classifies the uploaded/imported image:
`clean_product_photo | packshot | lifestyle_photo | existing_static_ad |
poster | screenshot | product_on_phone | logo | multi_product_collage`.

If the image is a **reference type** (poster/ad/collage/screenshot/phone/logo),
the pipeline sets `sourceImageHandling = reference_only`: extract the product +
branding from it and build a NEW real-world product scene — it must **not**
animate the artwork or show it on a device. A clean packshot is treated as the
literal hero product instead.

Default is a fast heuristic (role/filename/aspect, no cost). An optional Gemini
vision pass can disambiguate hard cases (not required; documented as future).

## Brand-aware planning

`BrandProfile` is an **active input**, scaled by a `brandInfluence` setting
(`low` 0.3 / `balanced` 0.65 / `strong` 1.0; balanced default). When the brand
is confident (`confidence ≥ 0.4`):
- the brand palette can replace the template's generic backdrop,
- brand `visualStyle`/`tone` override the template defaults in the brief,
- the prompt explicitly includes brand name, style, tone and colors.

When no confident brand exists, the prompt explicitly steers **away** from a
generic "AI luxury / silver" look and stays product-focused.

**Result:** two brands selling the same product get different prompts/concepts
(covered by tests).

## Templates that mean something

`lib/creative/templates.js` — each template defines lighting, camera language,
environment, pacing, product treatment, style and mood (not a one-line tweak).
These flow into the brief and scene plan. Templates: `luxury`, `bold`,
`minimal`, `product-demo`, `problem-solution`, `lifestyle`.

## Concepts before spending

`lib/creative/concepts.js` returns several distinct, brand-adaptive concepts
(deterministic, no AI cost) via `/api/creative/concepts`. The user picks a
direction in the review screen BEFORE any paid generation. Luxury vs. playful
vs. clean brands get different concept sets.

## Prompt quality + negative rules

`composeVideoPrompt()` builds a product/brand-specific prompt covering subject,
product identity + fidelity, environment, lighting, camera, scene plan, aspect
intent, and a strong negative block: no phones/tablets/screens, no
poster-in-frame, no generic silver sci-fi, no neon/holograms, no illegible AI
text or invented logos, no hands unless requested, no product mutation, etc. It
also instructs the model to leave negative space for exact logo/price/CTA
overlays rather than drawing promotional text.

## Text/logo = overlays, not generated

Promotional text and the exact logo are intentionally NOT generated inside the
footage (video models spell text poorly and can't reproduce an exact logo). The
prompt reserves negative space; deterministic composition (Remotion) will render
the headline/offer/price/CTA/logo in the next milestone. The output already
exposes `creative.brief`/`scenePlan` so composition can be layered cleanly.

## Product fidelity

Implemented today: reference-image conditioning (the uploaded/imported image is
passed to the image-to-video model) + strong fidelity instructions (preserve
shape, proportions, geometry, label, colors, logo). **Not yet implemented
(experimental / future):** segmentation / background removal, product masks,
first-frame compositing. Prompting alone does not guarantee fidelity — this is
documented as a known limitation.

## Where Gemini is / isn't used

- **Deterministic (no AI):** crawling, structured extraction, content cleaning,
  image discovery/ranking, brand-signal extraction, source-image heuristic,
  creative brief/scene plan, prompt composition, concept generation.
- **Gemini (paid):** only the final video generation step (unchanged provider).
  Optional future enrichment (benefits/angles/tone, vision classification) would
  be Gemini text/vision and is clearly separable.
