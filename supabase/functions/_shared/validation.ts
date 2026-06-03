import { z } from 'https://esm.sh/zod@3.23.8';

const trimmedString = (max: number) => z.string().trim().max(max);

export const generateSiteSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  businessName: trimmedString(120).optional().nullable(),
  businessType: trimmedString(80).optional().nullable(),
  clientLocation: trimmedString(120).optional().nullable(),
  sessionId: z.string().uuid().optional().nullable(),
  leadId: z.string().uuid().optional().nullable(),
  currentHtml: z.string().max(500_000).optional().nullable(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string().max(20_000),
      }),
    )
    .max(40)
    .optional()
    .nullable(),
});
export type GenerateSiteInput = z.infer<typeof generateSiteSchema>;

export const scrapeLeadsSchema = z.object({
  businessType: z.string().trim().min(1).max(80),
  city: z.string().trim().min(1).max(80),
  radius: z.enum(['1mi', '5mi', '10mi', '25mi']).optional(),
  maxResults: z.coerce.number().int().min(1).max(100).optional(),
  websiteFilter: z.enum(['without', 'both']).optional(),
});
export type ScrapeLeadsInput = z.infer<typeof scrapeLeadsSchema>;

export const createCheckoutSchema = z.object({
  origin: z.string().url().max(500).optional(),
});
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;

export const createPortalSchema = z.object({
  origin: z.string().url().max(500).optional(),
});
export type CreatePortalInput = z.infer<typeof createPortalSchema>;
