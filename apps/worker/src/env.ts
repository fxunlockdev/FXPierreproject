import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  TELEGRAM_API_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_API_HASH: z.string().min(10).optional(),
  SESSION_ENCRYPTION_KEY: z.string().min(32, 'SESSION_ENCRYPTION_KEY must be at least 32 chars'),
  WORKER_API_TOKEN: z.string().min(16, 'WORKER_API_TOKEN must be at least 16 chars'),
  PORT: z.coerce.number().int().default(8787),
  /** Safety-net poll for config changes; realtime handles most reloads. */
  CONFIG_POLL_SECONDS: z.coerce.number().int().min(1).default(30),
  SIMULATE: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v.toLowerCase() === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Worker environment is invalid:\n${issues}`);
  }
  if (!parsed.data.SIMULATE && (!parsed.data.TELEGRAM_API_ID || !parsed.data.TELEGRAM_API_HASH)) {
    throw new Error(
      'TELEGRAM_API_ID and TELEGRAM_API_HASH are required unless SIMULATE=1. ' +
        'Get them from https://my.telegram.org → API development tools.',
    );
  }
  return parsed.data;
}
