import { Injectable } from '@nestjs/common';
import {
  RECOMMENDATION_BEHAVIORAL_V8_PROBABILITY_CONTRACT,
  RecommendationBehavioralV8Decision,
  RecommendationBehavioralV8Prediction,
  validateRawBehaviorProbabilityVectorV8,
} from '@deadlock-live-probe/shared';

const REQUEST_CONTRACT = 'recommendation-behavioral-serving-request-v1' as const;
const RESPONSE_CONTRACT = 'recommendation-behavioral-serving-response-v1' as const;
const READY_CONTRACT = 'recommendation-behavioral-serving-ready-v1' as const;

export interface RecommendationBehavioralServingReadyV1 {
  contractVersion: typeof READY_CONTRACT;
  ready: true;
  modelId: string;
  modelVersion: string;
  manifestSha256: string;
  family: 'SEQUENCE_RNN' | 'SEQUENCE_TRANSFORMER';
  featureContractVersion: string;
  candidateGeneratorVersion: string;
  device: string;
  futureTestEvaluated: false;
}

export interface RecommendationBehavioralServingPredictionV1 {
  prediction: RecommendationBehavioralV8Prediction;
  modelId: string;
  modelVersion: string;
  manifestSha256: string;
  inferenceLatencyMs: number;
}

export interface RecommendationBehavioralServingPredictionInputV1 {
  decision: RecommendationBehavioralV8Decision;
  modelVersion: string;
  featureContractVersion: string;
  candidateGeneratorVersion: string;
  manifestSha256?: string;
}

@Injectable()
export class RecommendationBehavioralServingV1Service {
  configured(): boolean {
    return Boolean(process.env.RECOMMENDATION_BEHAVIORAL_SERVING_URL?.trim());
  }

  async ready(timeoutMs = 1_000): Promise<RecommendationBehavioralServingReadyV1> {
    const value = await this.request('/ready', { method: 'GET' }, timeoutMs);
    const record = object(value, 'Behavioral serving readiness response');
    if (record.contractVersion !== READY_CONTRACT) throw new Error('BEHAVIORAL_SERVING_READY_CONTRACT_MISMATCH');
    if (record.ready !== true) throw new Error('BEHAVIORAL_SERVING_NOT_READY');
    if (record.futureTestEvaluated !== false) throw new Error('BEHAVIORAL_SERVING_FUTURE_TEST_VIOLATION');
    const family = string(record.family, 'family');
    if (family !== 'SEQUENCE_RNN' && family !== 'SEQUENCE_TRANSFORMER') {
      throw new Error(`BEHAVIORAL_SERVING_FAMILY_INVALID:${family}`);
    }
    return {
      contractVersion: READY_CONTRACT,
      ready: true,
      modelId: string(record.modelId, 'modelId'),
      modelVersion: string(record.modelVersion, 'modelVersion'),
      manifestSha256: sha256(record.manifestSha256, 'manifestSha256'),
      family,
      featureContractVersion: string(record.featureContractVersion, 'featureContractVersion'),
      candidateGeneratorVersion: string(record.candidateGeneratorVersion, 'candidateGeneratorVersion'),
      device: string(record.device, 'device'),
      futureTestEvaluated: false,
    };
  }

  async predict(
    input: RecommendationBehavioralServingPredictionInputV1,
    timeoutMs = configuredTimeoutMs(),
  ): Promise<RecommendationBehavioralServingPredictionV1> {
    const value = await this.request('/predict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractVersion: REQUEST_CONTRACT,
        modelVersion: input.modelVersion,
        candidateGeneratorVersion: input.candidateGeneratorVersion,
        decision: input.decision,
      }),
    }, timeoutMs);
    const record = object(value, 'Behavioral serving prediction response');
    if (record.contractVersion !== RESPONSE_CONTRACT) throw new Error('BEHAVIORAL_SERVING_RESPONSE_CONTRACT_MISMATCH');
    if (record.modelVersion !== input.modelVersion) throw new Error('BEHAVIORAL_SERVING_MODEL_VERSION_MISMATCH');
    if (record.featureContractVersion !== input.featureContractVersion) throw new Error('BEHAVIORAL_SERVING_FEATURE_CONTRACT_MISMATCH');
    if (record.candidateGeneratorVersion !== input.candidateGeneratorVersion) {
      throw new Error('BEHAVIORAL_SERVING_CANDIDATE_GENERATOR_MISMATCH');
    }
    const manifestSha256 = sha256(record.manifestSha256, 'manifestSha256');
    if (input.manifestSha256 && manifestSha256 !== input.manifestSha256) {
      throw new Error('BEHAVIORAL_SERVING_MANIFEST_SHA_MISMATCH');
    }
    if (record.probabilityFloorApplied !== false) throw new Error('BEHAVIORAL_SERVING_PROBABILITY_FLOOR_FORBIDDEN');
    const candidates = array(record.candidates, 'candidates').map((candidateValue) => {
      const candidate = object(candidateValue, 'candidate');
      return {
        actionKey: string(candidate.actionKey, 'candidate.actionKey'),
        score: finite(candidate.score, 'candidate.score'),
        probability: finite(candidate.probability, 'candidate.probability'),
        rank: positiveInteger(candidate.rank, 'candidate.rank'),
      };
    });
    const prediction: RecommendationBehavioralV8Prediction = {
      decisionId: string(record.decisionId, 'decisionId'),
      probabilityContract: RECOMMENDATION_BEHAVIORAL_V8_PROBABILITY_CONTRACT,
      candidates,
      entropy: finite(record.entropy, 'entropy'),
    };
    if (record.probabilityContract !== RECOMMENDATION_BEHAVIORAL_V8_PROBABILITY_CONTRACT) {
      throw new Error('BEHAVIORAL_SERVING_PROBABILITY_CONTRACT_MISMATCH');
    }
    if (prediction.decisionId !== input.decision.decisionId) throw new Error('BEHAVIORAL_SERVING_DECISION_ID_MISMATCH');
    validateRawBehaviorProbabilityVectorV8(prediction, 1e-6);
    assertExactCandidateSet(input.decision, prediction);
    return {
      prediction,
      modelId: string(record.modelId, 'modelId'),
      modelVersion: input.modelVersion,
      manifestSha256,
      inferenceLatencyMs: nonNegative(record.inferenceLatencyMs, 'inferenceLatencyMs'),
    };
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const base = configuredBaseUrl();
    const headers = new Headers(init.headers);
    const token = process.env.RECOMMENDATION_BEHAVIORAL_SERVING_TOKEN?.trim();
    if (token) headers.set('authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(new URL(path, `${base}/`), {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`BEHAVIORAL_SERVING_UNREACHABLE:${errorMessage(error)}`);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`BEHAVIORAL_SERVING_INVALID_JSON:HTTP_${response.status}`);
    }
    if (!response.ok) {
      const detail = typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error?: unknown }).error)
        : `HTTP_${response.status}`;
      throw new Error(`BEHAVIORAL_SERVING_HTTP_${response.status}:${detail}`);
    }
    return body;
  }
}

function configuredBaseUrl(): string {
  const raw = process.env.RECOMMENDATION_BEHAVIORAL_SERVING_URL?.trim();
  if (!raw) throw new Error('BEHAVIORAL_SERVING_URL_NOT_CONFIGURED');
  const url = new URL(raw);
  const loopbackHttp = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('BEHAVIORAL_SERVING_URL_MUST_BE_HTTPS_OR_LOOPBACK_HTTP');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('BEHAVIORAL_SERVING_URL_INVALID');
  return url.toString().replace(/\/$/, '');
}

function configuredTimeoutMs(): number {
  const parsed = Number(process.env.RECOMMENDATION_BEHAVIORAL_SERVING_TIMEOUT_MS ?? 150);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_000) return 150;
  return Math.floor(parsed);
}

function assertExactCandidateSet(
  decision: RecommendationBehavioralV8Decision,
  prediction: RecommendationBehavioralV8Prediction,
): void {
  const expected = [...decision.candidates.map((candidate) => candidate.actionKey)].sort();
  const actual = [...prediction.candidates.map((candidate) => candidate.actionKey)].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('BEHAVIORAL_SERVING_CANDIDATE_SET_MISMATCH');
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function sha256(value: unknown, name: string): string {
  const parsed = string(value, name);
  if (!/^[a-f0-9]{64}$/i.test(parsed)) throw new Error(`${name} must be SHA256`);
  return parsed.toLowerCase();
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function nonNegative(value: unknown, name: string): number {
  const parsed = finite(value, name);
  if (parsed < 0) throw new Error(`${name} must be non-negative`);
  return parsed;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
