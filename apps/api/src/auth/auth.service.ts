import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { MeResponse, ProviderId } from '@vizscript/api-contract';
import type { Kysely } from 'kysely';
import {
  createSessionToken,
  hashSessionToken,
  SecretBox,
} from '../common/crypto';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import { DB } from '../database/database.module';
import type { Database } from '../database/schema';
import { ScmRegistry } from '../scm/scm.registry';

export interface SessionUser {
  userId: string;
  sessionId: string;
}

export const SESSION_COOKIE = 'vz_session';

@Injectable()
export class AuthService {
  private readonly box: SecretBox;

  public constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ScmRegistry) private readonly scm: ScmRegistry
  ) {
    this.box = new SecretBox(config.appSecret);
  }

  /**
   * Verifies a provider token, upserts the user and stores the encrypted
   * token. Returns a new session token.
   *
   * Later an OIDC login (Keycloak with GitHub IdP) can call the same
   * `upsertIdentity` + `storeToken` path with the broker token.
   */
  public async loginWithToken(
    provider: ProviderId,
    token: string
  ): Promise<{ sessionToken: string; expiresAt: Date }> {
    const identity = await this.scm.get(provider).verifyToken(token);
    const encrypted = this.box.encrypt(token);

    const userId = await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('identities')
        .select('user_id')
        .where('provider', '=', provider)
        .where('provider_user_id', '=', identity.providerUserId)
        .executeTakeFirst();

      let id = existing?.user_id;
      if (id) {
        await trx
          .updateTable('identities')
          .set({
            login: identity.login,
            name: identity.name,
            avatar_url: identity.avatarUrl,
            updated_at: new Date(),
          })
          .where('provider', '=', provider)
          .where('provider_user_id', '=', identity.providerUserId)
          .execute();
      } else {
        const user = await trx
          .insertInto('users')
          .defaultValues()
          .returning('id')
          .executeTakeFirstOrThrow();
        id = user.id;
        await trx
          .insertInto('identities')
          .values({
            user_id: id,
            provider,
            provider_user_id: identity.providerUserId,
            login: identity.login,
            name: identity.name,
            avatar_url: identity.avatarUrl,
          })
          .execute();
      }

      await trx
        .insertInto('scm_credentials')
        .values({
          user_id: id,
          provider,
          token_ciphertext: encrypted.ciphertext,
          token_iv: encrypted.iv,
          token_tag: encrypted.tag,
          scopes: identity.scopes,
        })
        .onConflict((oc) =>
          oc.columns(['user_id', 'provider']).doUpdateSet({
            token_ciphertext: encrypted.ciphertext,
            token_iv: encrypted.iv,
            token_tag: encrypted.tag,
            scopes: identity.scopes,
            updated_at: new Date(),
          })
        )
        .execute();

      return id;
    });

    const sessionToken = createSessionToken();
    const expiresAt = new Date(
      Date.now() + this.config.sessionTtlDays * 24 * 60 * 60 * 1000
    );
    await this.db
      .insertInto('sessions')
      .values({
        id: hashSessionToken(sessionToken),
        user_id: userId,
        expires_at: expiresAt,
      })
      .execute();

    return { sessionToken, expiresAt };
  }

  public async resolveSession(
    sessionToken: string | undefined
  ): Promise<SessionUser | null> {
    if (!sessionToken) {
      return null;
    }

    const sessionId = hashSessionToken(sessionToken);
    const session = await this.db
      .selectFrom('sessions')
      .select(['user_id', 'expires_at'])
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!session || session.expires_at.getTime() < Date.now()) {
      return null;
    }

    return { userId: session.user_id, sessionId };
  }

  public async logout(sessionId: string): Promise<void> {
    await this.db.deleteFrom('sessions').where('id', '=', sessionId).execute();
  }

  public async me(userId: string): Promise<MeResponse> {
    const identity = await this.db
      .selectFrom('identities')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('updated_at', 'desc')
      .executeTakeFirst();
    if (!identity) {
      throw new UnauthorizedException();
    }

    return {
      id: userId,
      provider: identity.provider as ProviderId,
      login: identity.login,
      name: identity.name,
      avatarUrl: identity.avatar_url,
    };
  }

  /** Decrypted provider token of a user. */
  public async providerToken(
    userId: string,
    provider: ProviderId
  ): Promise<string> {
    const row = await this.db
      .selectFrom('scm_credentials')
      .select(['token_ciphertext', 'token_iv', 'token_tag'])
      .where('user_id', '=', userId)
      .where('provider', '=', provider)
      .executeTakeFirst();
    if (!row) {
      throw new UnauthorizedException(`No ${provider} token stored`);
    }

    return this.box.decrypt({
      ciphertext: row.token_ciphertext,
      iv: row.token_iv,
      tag: row.token_tag,
    });
  }
}
