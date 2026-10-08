import { z } from "zod";

const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  ZOHO_CLIENT_ID: z.string().min(1),
  ZOHO_CLIENT_SECRET: z.string().min(1),
  // 32 random bytes, base64. Generate with: openssl rand -base64 32
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  // Public origin used to build the Zoho redirect URI. Falls back to Vercel's URL.
  APP_URL: z.url().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Validated server env. Throws a readable error listing every missing variable. */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server environment:\n${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** Public origin of this deployment, without a trailing slash. */
export function appUrl(): string {
  const explicit = serverEnv().APP_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

export function zohoRedirectUri(): string {
  return `${appUrl()}/api/oauth/zoho/callback`;
}
