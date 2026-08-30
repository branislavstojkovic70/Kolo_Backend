import { plainToInstance } from 'class-transformer';
import {
  IsBooleanString,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Min,
  validateSync,
} from 'class-validator';
import { Type } from 'class-transformer';

class EnvironmentVariables {
  // --- required, fail fast ---
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @IsNotEmpty()
  CLERK_SECRET_KEY: string;

  @IsString()
  @IsNotEmpty()
  OXAPAY_MERCHANT_API_KEY: string;

  // --- optional infra ---
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  PORT?: number;

  @IsOptional()
  @IsString()
  PUBLIC_API_URL?: string;

  @IsOptional()
  @IsString()
  FRONTEND_URL?: string;

  @IsOptional()
  @IsString()
  CLERK_PUBLISHABLE_KEY?: string;

  @IsOptional()
  @IsString()
  ADMIN_EMAILS?: string;

  @IsOptional()
  @IsString()
  NODE_ENV?: string;

  // dev-only auth bypass, see CLAUDE.md section 7
  @IsOptional()
  @IsBooleanString()
  DEV_AUTH_BYPASS?: string;

  @IsOptional()
  @IsString()
  OXAPAY_PAYOUT_API_KEY?: string;

  @IsOptional()
  @IsBooleanString()
  OXAPAY_SANDBOX?: string;

  // skip live OxaPay HTTP calls, see oxapay.service.ts
  @IsOptional()
  @IsBooleanString()
  OXAPAY_MOCK?: string;

  // --- telegram: all optional, disputes must work without it ---
  @IsOptional()
  @IsNumberString()
  TELEGRAM_API_ID?: string;

  @IsOptional()
  @IsString()
  TELEGRAM_API_HASH?: string;

  @IsOptional()
  @IsString()
  TELEGRAM_SESSION?: string;

  @IsOptional()
  @IsString()
  TELEGRAM_BOT_TOKEN?: string;

  @IsOptional()
  @IsString()
  TELEGRAM_BOT_USERNAME?: string;

  @IsOptional()
  @IsString()
  TELEGRAM_ADMIN_USERNAMES?: string;

  // --- business knobs ---
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  VESTING_DAYS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  DISPUTE_WINDOW_DAYS?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  PLATFORM_FEE_PERCENT?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  MIN_WITHDRAWAL_USD?: number;
}

export function validateEnv(config: Record<string, unknown>) {
  // An unset var in .env arrives as '' — treat that as absent so optional vars
  // (all the Telegram ones) may be left blank. Required vars still fail on undefined.
  const cleaned = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== ''),
  );

  const validated = plainToInstance(EnvironmentVariables, cleaned, {
    enableImplicitConversion: false,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment variables:\n${details}`);
  }

  return config;
}
