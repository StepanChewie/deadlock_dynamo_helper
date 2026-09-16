import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import {
  INTERNAL_API_KEY_HEADER,
  InternalApiGuard,
} from '../src/common/internal-api.guard';

const KEY = 'test-internal-key-0123456789';

function contextWithHeaders(
  headers: Record<string, string | string[] | undefined>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function activate(headers: Record<string, string | string[] | undefined>): boolean {
  return new InternalApiGuard().canActivate(contextWithHeaders(headers));
}

describe('InternalApiGuard', () => {
  const originalKey = process.env.INTERNAL_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.INTERNAL_API_KEY;
    } else {
      process.env.INTERNAL_API_KEY = originalKey;
    }
  });

  describe('fail closed', () => {
    it('rejects when the key is not configured at all', () => {
      delete process.env.INTERNAL_API_KEY;
      expect(() => activate({})).toThrow(UnauthorizedException);
    });

    it('rejects a request that supplies a key when the server has none configured', () => {
      delete process.env.INTERNAL_API_KEY;
      expect(() => activate({ [INTERNAL_API_KEY_HEADER]: KEY })).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects when the configured key is only whitespace', () => {
      process.env.INTERNAL_API_KEY = '   ';
      expect(() => activate({ [INTERNAL_API_KEY_HEADER]: 'anything' })).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('accepts the configured key', () => {
    beforeEach(() => {
      process.env.INTERNAL_API_KEY = KEY;
    });

    it('accepts an exact match', () => {
      expect(activate({ [INTERNAL_API_KEY_HEADER]: KEY })).toBe(true);
    });

    it('accepts a key with surrounding whitespace on either side', () => {
      process.env.INTERNAL_API_KEY = `  ${KEY}  `;
      expect(activate({ [INTERNAL_API_KEY_HEADER]: `\t${KEY}\n` })).toBe(true);
    });

    it('uses the first value when the header is repeated', () => {
      expect(activate({ [INTERNAL_API_KEY_HEADER]: [KEY, 'decoy'] })).toBe(true);
    });
  });

  describe('rejects a bad key', () => {
    beforeEach(() => {
      process.env.INTERNAL_API_KEY = KEY;
    });

    it('rejects a missing header', () => {
      expect(() => activate({})).toThrow(UnauthorizedException);
    });

    it('rejects an empty header', () => {
      expect(() => activate({ [INTERNAL_API_KEY_HEADER]: '' })).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a wrong key of the same length', () => {
      const wrong = 'X'.repeat(KEY.length);
      expect(() => activate({ [INTERNAL_API_KEY_HEADER]: wrong })).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a wrong key of a different length', () => {
      expect(() => activate({ [INTERNAL_API_KEY_HEADER]: 'short' })).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a prefix of the real key', () => {
      expect(() =>
        activate({ [INTERNAL_API_KEY_HEADER]: KEY.slice(0, KEY.length - 1) }),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a repeated header whose first value is wrong', () => {
      expect(() => activate({ [INTERNAL_API_KEY_HEADER]: ['nope', KEY] })).toThrow(
        UnauthorizedException,
      );
    });

    it('does not read the key from an unrelated header', () => {
      expect(() => activate({ authorization: `Bearer ${KEY}` })).toThrow(
        UnauthorizedException,
      );
    });
  });
});
