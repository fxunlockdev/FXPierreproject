import { z } from 'zod';
import { DateTime } from 'luxon';
import { MEDIA_KINDS, type PipelineContext, type RelayMessage, type RichText } from './types.js';
import { checkFilters } from './filters.js';
import { applyLinkRemoval, applyReplacements, stripSignature } from './transforms.js';
import { appendRichText, prependRichText, tidyWhitespace, truncateRichText } from './richtext.js';
import { expandVariables, parseMiniMarkdown } from './mini-markdown.js';

/** Telegram hard limits */
export const MAX_TEXT_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;

// ── schemas ────────────────────────────────────────────────────────────────

export const RouteFiltersSchema = z
  .object({
    includeKeywords: z.array(z.string().min(1).max(200)).max(100).default([]),
    excludeKeywords: z.array(z.string().min(1).max(200)).max(100).default([]),
    includeRegex: z.string().max(500).optional(),
    excludeRegex: z.string().max(500).optional(),
    caseSensitive: z.boolean().default(false),
    wholeWord: z.boolean().default(false),
    mediaTypes: z.array(z.enum(MEDIA_KINDS)).optional(),
    minLength: z.number().int().min(0).max(MAX_TEXT_LENGTH).optional(),
    maxLength: z.number().int().min(0).max(MAX_TEXT_LENGTH).optional(),
  })
  .default({});

export const ReplacementSchema = z.object({
  find: z.string().min(1).max(500),
  replace: z.string().max(500).default(''),
  regex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
});

export const LinkRemovalSchema = z
  .object({
    urls: z.enum(['off', 'tme', 'all']).default('off'),
    mentions: z.boolean().default(false),
    hashtags: z.boolean().default(false),
    buttons: z.boolean().default(false),
    placeholder: z.string().max(50).default(''),
  })
  .default({});

export const RouteRulesSchema = z
  .object({
    filters: RouteFiltersSchema,
    replacements: z.array(ReplacementSchema).max(50).default([]),
    linkRemoval: LinkRemovalSchema,
    header: z.string().max(1000).default(''),
    footer: z.string().max(1000).default(''),
    signatureStrip: z.string().max(500).default(''),
  })
  .default({});

export const RouteScheduleSchema = z.object({
  tz: z
    .string()
    .refine((tz) => DateTime.local().setZone(tz).isValid, { message: 'invalid timezone' }),
  windows: z
    .array(
      z.object({
        dow: z.number().int().min(0).max(6), // 0 = Sunday … 6 = Saturday
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }),
    )
    .max(50),
  offWindow: z.enum(['hold', 'drop']).default('hold'),
  dropHeldAfterMinutes: z.number().int().min(1).max(10080).optional(),
});

export type RouteFilters = z.infer<typeof RouteFiltersSchema>;
export type Replacement = z.infer<typeof ReplacementSchema>;
export type LinkRemoval = z.infer<typeof LinkRemovalSchema>;
export type RouteRules = z.infer<typeof RouteRulesSchema>;
export type RouteSchedule = z.infer<typeof RouteScheduleSchema>;

/** Parse rules coming from the database; malformed JSON degrades to defaults. */
export function parseRouteRules(json: unknown): RouteRules {
  const parsed = RouteRulesSchema.safeParse(json ?? {});
  return parsed.success ? parsed.data : RouteRulesSchema.parse({});
}

export function parseRouteSchedule(json: unknown): RouteSchedule | null {
  if (json === null || json === undefined) return null;
  const parsed = RouteScheduleSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// ── pipeline ───────────────────────────────────────────────────────────────

export type PipelineResult =
  | { action: 'drop'; reason: string }
  | { action: 'pass'; output: RichText; removeButtons: boolean };

/**
 * The full per-route content pipeline:
 * filters → signature strip → replacements → link removal → header/footer →
 * whitespace tidy → Telegram length cap.
 */
export function applyRules(
  msg: RelayMessage,
  rules: RouteRules,
  ctx: PipelineContext,
): PipelineResult {
  const filter = checkFilters(msg, rules.filters);
  if (!filter.pass) return { action: 'drop', reason: filter.reason };

  let out = msg.text;

  if (rules.signatureStrip) out = stripSignature(out, rules.signatureStrip);
  if (rules.replacements.length > 0) out = applyReplacements(out, rules.replacements);
  out = applyLinkRemoval(out, rules.linkRemoval);

  const now = ctx.now ?? new Date();
  const vars = {
    masterTitle: ctx.masterTitle,
    masterUsername: ctx.masterUsername,
    messageLink: ctx.messageLink,
    now,
    tz: ctx.tz,
  };

  if (rules.header) {
    out = prependRichText(parseMiniMarkdown(expandVariables(rules.header, vars)), out);
  }
  if (rules.footer) {
    out = appendRichText(out, parseMiniMarkdown(expandVariables(rules.footer, vars)));
  }

  out = tidyWhitespace(out);
  out = truncateRichText(out, msg.media === 'text' ? MAX_TEXT_LENGTH : MAX_CAPTION_LENGTH);

  return { action: 'pass', output: out, removeButtons: rules.linkRemoval.buttons };
}
