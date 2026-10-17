/**
 * /api/languages
 *   GET  ?q=  — searchable language catalogue + mixed presets + caption scripts
 *   POST      — honest capability assessment for a language profile
 *               (writing, voice, captions, rendering, dialogue)
 */

import { NextResponse } from "next/server";
import { searchLanguages, MIXED_PRESETS, LANGUAGES } from "@/lib/i18n/languages.js";
import { languageProfileSchema, assessLanguageProfile } from "@/lib/i18n/profile.js";
import { SCRIPT_NAMES, hasFontForScript } from "@/lib/i18n/scripts.js";

export async function GET(request) {
  const q = new URL(request.url).searchParams.get("q") || "";
  const results = q ? searchLanguages(q, 40) : LANGUAGES;
  return NextResponse.json({
    languages: results.filter((l) => l.kind !== "mixed").map((l) => ({ code: l.code, name: l.name, native: l.native, scripts: l.scripts, rtl: l.rtl, tts: l.tts })),
    presets: MIXED_PRESETS,
    scripts: Object.entries(SCRIPT_NAMES).map(([code, name]) => ({ code, name, fontInstalled: hasFontForScript(code) })),
  });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = languageProfileSchema.safeParse(body?.language ?? body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid language profile.", details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 422 });
  }
  return NextResponse.json(assessLanguageProfile(parsed.data, { narration: body?.narration !== false }));
}
