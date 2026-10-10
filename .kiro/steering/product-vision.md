---
inclusion: always
---

# MakeAdClips — product vision (guardrails for all work)

## What MakeAdClips is

> Give us your website, product, social profile or assets. We understand what
> you're selling, understand your brand, develop an advertising concept, and
> create a professional video advertisement — with minimal user effort.

The differentiator is **deep source intelligence that produces high-quality,
brand-accurate video ads from one simple action** — not editing controls.

## The core flow (do not deviate)

```
Import URL / upload assets
  → understand entity + brand (Source Intelligence, cheap text/vision)
  → recommend professional concepts
  → user approves creative direction (read-only review + preflight)
  → generate high-quality video
  → preview / download
```

Keep creative planning, visual intelligence, automatic asset selection, prompt
construction and output quality checks **behind the scenes**. Success = one
action yields an excellent, relevant ad.

## We are NOT building a video editor

Do NOT add (unless the user explicitly reverses this):
- timeline / scrubber editing
- manual per-scene editing, drag-and-drop scene reordering
- layers / tracks
- complex audio mixing controls
- a Runway/CapCut-style editing workspace

A storyboard/plan shown before generation must be a **read-only summary the user
approves or regenerates** — not an editable timeline. Light edits to the
extracted *profile* (name, offer, hero image, concept choice, brand influence)
are fine; scene-level manual editing is not.

## Video model policy

- Access all video models through the `VideoProvider` abstraction
  (`lib/ai/provider.js` + `getVideoProvider`). The route handler and UI must
  NEVER hardcode a model; selection is config-driven via `VIDEO_MODEL` and
  described in `lib/ai/modelRegistry.js`.
- Default to a **GA, non-deprecated** model. Current default:
  `gemini-omni-1.1-flash`.
- Do NOT couple the product to **Veo 3.1 Lite** (cheapest/sec but Gemini-API
  preview shutdown ~2026-10-22). It's a registry reference entry only.
- Choose models on **usable output quality**, not just price (`qualityNotes` in
  the registry). Switching models must be a config + small adapter change, never
  a workflow rewrite.

## Cost discipline

- Do cheap text/vision intelligence to build an accurate plan BEFORE any paid
  video call.
- Paid video generation stays **OFF by default** and is gated by the creative
  preflight. Never make a paid API call without explicit user approval.
