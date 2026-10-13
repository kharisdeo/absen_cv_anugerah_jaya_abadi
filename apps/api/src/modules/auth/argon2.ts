import { randomBytes } from 'node:crypto';

import * as argon2 from 'argon2';

import type { AuditService } from '../audit/index.js';
import type { DeviceBindingService } from '../device-binding/index.js';
import type { AuthRepository, ConsentStatusReader, PasswordHasher } from './contracts.js';
import { AuthService } from './service.js';

export const argon2PasswordHasher: PasswordHasher = {
  hash: (password) => argon2.hash(password, { type: argon2.argon2id }),
  verify: (passwordHash, password) => argon2.verify(passwordHash, password),
};

export async function createArgon2AuthService(
  repository: AuthRepository,
  audit: Pick<AuditService, 'record'>,
  consentStatus: ConsentStatusReader,
  deviceBindings?: Pick<DeviceBindingService, 'enroll'>,
): Promise<AuthService> {
  const dummyPasswordHash = await argon2PasswordHasher.hash(randomBytes(32).toString('base64url'));
  return new AuthService({
    repository,
    passwordHasher: argon2PasswordHasher,
    audit,
    dummyPasswordHash,
    consentStatus,
    ...(deviceBindings ? { deviceBindings } : {}),
  });
}
