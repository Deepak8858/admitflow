import { z } from "zod";

const metaId = z.string().regex(/^\d{1,80}$/);
export const metaLeadFormSchema = z.object({
  id: metaId, created_time: z.string().max(100).optional(), form_id: metaId.optional(), ad_id: metaId.optional(),
  field_data: z.array(z.object({ name: z.string().min(1).max(200), values: z.array(z.string().max(10000)).max(50) })).max(100),
});
export const whatsappIntakeSchema = z.object({
  id: z.string().min(1).max(512), from: z.string().min(1).max(30), name: z.string().max(100).optional(),
  body: z.string().max(4000), timestamp: z.string().max(20).optional(), echo: z.boolean().optional(),
  verified: z.literal(true), mediaType: z.string().max(40).optional(), mediaId: z.string().max(512).optional(),
});
export const metaLeadEventSchema = z.object({ pageId: metaId, leadgenId: metaId, formId: metaId.optional(), adId: metaId.optional(), createdTime: z.number().int().positive().max(253402300799).optional() });
export const intakePayloadSchema = z.discriminatedUnion("service", [
  z.object({ service: z.literal("whatsapp"), event: whatsappIntakeSchema }),
  z.object({ service: z.literal("meta_leads"), event: metaLeadEventSchema, form: metaLeadFormSchema }),
]);
export type IntakePayload = z.infer<typeof intakePayloadSchema>;
export const MAX_INTAKE_BYTES = 128 * 1024;
