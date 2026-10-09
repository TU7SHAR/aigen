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

export const generateRequestSchema = z.object({
  productName: z.string().trim().min(1, "Product name is required").max(120),
  brand: z.string().trim().max(120).optional().default(""),
  description: z.string().trim().max(1000).optional().default(""),
  offer: z.string().trim().max(240).optional().default(""),
  cta: z.string().trim().max(80).optional().default(""),
  template: z.enum(TEMPLATES),
  aspectRatio: z.enum(ASPECT_RATIOS),
  resolution: z.enum(RESOLUTIONS).optional().default("720p"),
  durationSeconds: z.number().int().min(3).max(10).optional().default(8),
  image: imageSchema.optional(),
  // Optional override of the generated prompt (user may edit it in the UI).
  promptOverride: z.string().trim().max(2000).optional(),
  // Client-generated idempotency key to guard against duplicate submits.
  clientRequestId: z.string().trim().min(1).max(100).optional(),
});

/** @typedef {z.infer<typeof generateRequestSchema>} GenerateRequest */
