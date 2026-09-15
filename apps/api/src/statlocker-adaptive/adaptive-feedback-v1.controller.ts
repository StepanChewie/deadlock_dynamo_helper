import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdaptiveFeedbackV1Entity } from '../deadlock-live/entities/adaptive-feedback-v1.entity';

/**
 * Reasons the client offers when a player answers "No" to the post-match prompt.
 * Kept as an allowlist so an unknown value is dropped rather than stored, which
 * keeps the column meaningful for later aggregation.
 */
export const ADAPTIVE_FEEDBACK_REASONS_V1 = [
  'Bad item recommendation',
  'Bad order',
  'Recommendation changed too much',
  'Recommendation was too late',
  "App didn't detect my state correctly",
  'Other',
] as const;

export type AdaptiveFeedbackReasonV1 = (typeof ADAPTIVE_FEEDBACK_REASONS_V1)[number];

export interface AdaptiveFeedbackRequestV1 {
  appVersion?: string;
  matchId?: string;
  useful?: boolean;
  reason?: string;
  requestId?: string;
}

export interface AdaptiveFeedbackResponseV1 {
  accepted: boolean;
}

function normalizeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

function normalizeReason(value: unknown): AdaptiveFeedbackReasonV1 | null {
  const reason = normalizeString(value, 64);
  return ADAPTIVE_FEEDBACK_REASONS_V1.find((allowed) => allowed === reason) ?? null;
}

/**
 * Collects post-match usefulness votes.
 *
 * Writes to its own table and nothing else. ADR-007 forbids feeding own match
 * data back into policy learning, so this endpoint must never grow a path into
 * the recommendation pipeline.
 */
@Controller('deadlock/adaptive/v1')
export class AdaptiveFeedbackV1Controller {
  constructor(
    @InjectRepository(AdaptiveFeedbackV1Entity)
    private readonly feedback: Repository<AdaptiveFeedbackV1Entity>,
  ) {}

  @Post('feedback')
  async submit(@Body() body: AdaptiveFeedbackRequestV1): Promise<AdaptiveFeedbackResponseV1> {
    const matchId = normalizeString(body?.matchId, 128);
    if (!matchId) {
      throw new BadRequestException('matchId is required.');
    }

    if (typeof body?.useful !== 'boolean') {
      throw new BadRequestException('useful must be a boolean.');
    }

    await this.feedback.insert({
      appVersion: normalizeString(body?.appVersion, 32) ?? 'unknown',
      matchId,
      useful: body.useful,
      reason: normalizeReason(body?.reason),
      requestId: normalizeString(body?.requestId, 128),
    });

    return { accepted: true };
  }
}
