import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function deriveKey(appSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret, 'vizscript', purpose, 32));
}

/** AES-256-GCM encryption for provider tokens at rest. */
export class SecretBox {
  private readonly key: Buffer;

  public constructor(appSecret: string) {
    this.key = deriveKey(appSecret, 'scm-token');
  }

  public encrypt(plaintext: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  public decrypt(secret: EncryptedSecret): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, secret.iv);
    decipher.setAuthTag(secret.tag);
    return Buffer.concat([
      decipher.update(secret.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
