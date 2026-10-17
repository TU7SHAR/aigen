/**
 * Server-side input validation with Zod.
 */

import { z } from "zod";
import {
  ASPECT_RATIOS,
  RESOLUTIONS,
  TEMPLATES,
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  VIDEO_FORMATS,
} from "./config.js";

const imageSchema = z
  .object({
    data: z.string().min(1), // base64, no data: prefix
    mimeType: z.enum(ALLOWED_IMAGE_MIME),
  })
  .refine(
    (img) => {
      // Approx decoded size from base64 length (4 chars -> 3 bytes).
      const approxBytes = Math.floor((img.data.length * 3) / 4);
      return approxBytes <= MAX_IMAGE_BYTES;
    },
    { message: `Image exceeds max size of ${MAX_IMAGE_BYTES} bytes.` }
  );

import { BRAND_INFLUENCE_LEVELS } from "./config.js";

export const generateRequestSchema = z.object({
  productName: z.string().trim().min(1, "Product name is required").max(120),
  brand: z.string().trim().max(120).optional().default(""),
  description: z.string().trim().max(1000).optional().default(""),
  offer: z.string().trim().max(240).optional().default(""),
  cta: z.string().trim().max(80).optional().default(""),
  // Template drives only the deterministic copy framing; an unknown/absent one
  // should NOT hard-fail generation (the AI storyboard carries the real plan).
  // Default to a neutral template instead of a 422.
  template: z.enum(TEMPLATES).catch("minimal").default("minimal"),
  aspectRatio: z.enum(ASPECT_RATIOS).catch("9:16").default("9:16"),
  resolution: z.enum(RESOLUTIONS).optional().default("720p"),
  durationSeconds: z.number().int().min(3).max(15).optional().default(8),
  image: imageSchema.optional(),
  // Optional override of the generated prompt (user may edit it in the UI).
  promptOverride: z.string().trim().max(4000).optional(),
  // Client-generated idempotency key to guard against duplicate submits.
  clientRequestId: z.string().trim().min(1).max(100).optional(),

  // --- Creative-pipeline inputs (all optional; the pipeline degrades
  // gracefully when absent) ---
  // Full ProductProfile from import, if available (passthrough — already
  // validated at import time; we only read a few fields here).
  productProfile: z.object({}).passthrough().optional(),
  // BrandProfile from import, if available.
  brandProfile: z.object({}).passthrough().nullable().optional(),
  // How strongly brand identity constrains the creative.
  brandInfluence: z.enum(BRAND_INFLUENCE_LEVELS).optional().default("balanced"),
  // The user's free-text intent / angle, if any.
  userIntent: z.string().trim().max(500).optional(),
  // Detected entity type and the chosen concept, carried from import/review.
  entityType: z.string().max(40).optional(),
  concept: z.object({}).passthrough().nullable().optional(),
  // AI Creative Director storyboard carried from review (executable shots).
  storyboard: z.object({}).passthrough().nullable().optional(),
  // DesignProfile (visual intelligence) + entity confidence, carried from import.
  designProfile: z.object({}).passthrough().nullable().optional(),
  entityConfidence: z.number().min(0).max(1).optional(),
  // A chosen imported asset to use as the generation reference. The server
  // fetches it SSRF-safely (so the crawler's image actually reaches the model),
  // instead of requiring the client to re-upload base64.
  referenceAssetUrl: z.string().trim().max(2000).optional(),
  referenceAssetRole: z.string().max(40).optional(),
  // Classification of the source image, if the client already ran it, or a
  // hint so the server can classify. { role?, url?, hintText? }
  sourceImageMeta: z.object({}).passthrough().optional(),

  // --- Product PR A: user corrections & controls (all optional; propagate
  // into creative planning + the generation prompt). No industry hardcoding —
  // these are free user inputs, used verbatim as grounding/constraints. ---
  // User-corrected classification. `entityType` already exists above; these
  // let the user refine what the thing actually is.
  category: z.string().trim().max(120).optional(),
  offering: z.string().trim().max(300).optional(),
  // Features / benefits / messages the user wants EMPHASIZED. Injected as
  // affirmative grounding in the prompt and carried on the brief.
  emphasis: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  // Things that MUST NOT appear. Appended to the prompt's negative/avoid list.
  avoid: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  // Multiple user-selected imported references (add/remove/select in review).
  // Each: a stored/remote URL + the role the user assigned it. The first entry
  // (or the one flagged `primary`) becomes the primary reference; the rest are
  // additional context the pipeline may use. Resolved SSRF-safely server-side.
  referenceAssets: z
    .array(
      z.object({
        url: z.string().trim().min(1).max(2000),
        role: z.string().max(40).optional(),
        primary: z.boolean().optional(),
      })
    )
    .max(8)
    .optional(),

  // --- Production format + rendering controls ---
  // Which production route to use. `screen_demo` and `cinematic_card` are
  // DETERMINISTIC (ffmpeg compositor, no paid model). `generative` requests a
  // paid video model (gated). Defaults to the deterministic screen path.
  format: z.enum(VIDEO_FORMATS).optional(),
  // Explicit dry-run: compile + render the deterministic plan/output but never
  // call a paid generative model. (Server also forces dry-run when paid gen is
  // hard-disabled.)
  dryRun: z.boolean().optional(),
  // All selected imported asset urls (for the screen renderer to animate real
  // screenshots). Separate from referenceAssets so the single-reference
  // provider path is unaffected.
  galleryUrls: z.array(z.string().trim().min(1).max(2000)).max(12).optional(),
});

/** @typedef {z.infer<typeof generateRequestSchema>} GenerateRequest */
