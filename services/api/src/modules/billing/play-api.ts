import { createSign } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { PlaySubscriptionV2 } from './play-state.js';

/** What the billing module needs from Google Play. Swappable for tests. */
export interface PlayApi {
  getSubscription(packageName: string, token: string): Promise<PlaySubscriptionV2 | null>;
  acknowledge(packageName: string, productId: string, token: string): Promise<void>;
}

/** Verifies a Pub/Sub push OIDC token. Returns the verified claims or throws. */
export interface PushTokenVerifier {
  verify(
    bearer: string,
  ): Promise<{ email?: string; email_verified?: boolean; aud?: string | string[] }>;
}

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 JWT assertion for the OAuth 2.0 JWT-bearer grant (exported for tests). */
export function serviceAccountAssertion(sa: ServiceAccount, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${b64url(sig)}`;
}

/**
 * Real Google Play client. Credentials come from a Secrets Manager secret holding the service
 * account JSON (created empty by CDK; the owner pastes the key). Never logged.
 */
export class HttpPlayApi implements PlayApi {
  private token: { value: string; exp: number } | null = null;
  private sa: ServiceAccount | null = null;

  constructor(
    private readonly secretArn: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async account(): Promise<ServiceAccount> {
    if (this.sa) return this.sa;
    const r = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: this.secretArn }),
    );
    const sa = JSON.parse(r.SecretString ?? '{}') as ServiceAccount;
    if (!sa.client_email || !sa.private_key)
      throw new Error('Play service account secret is not configured');
    return (this.sa = sa);
  }

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.exp - 60 > now) return this.token.value;
    const sa = await this.account();
    const res = await this.fetchImpl(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: serviceAccountAssertion(sa, now),
      }),
    });
    if (!res.ok) throw new Error(`Google token endpoint returned ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: now + j.expires_in };
    return j.access_token;
  }

  async getSubscription(packageName: string, token: string): Promise<PlaySubscriptionV2 | null> {
    const url = `${API}/applications/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`;
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`Play subscriptionsv2.get returned ${res.status}`);
    return (await res.json()) as PlaySubscriptionV2;
  }

  async acknowledge(packageName: string, productId: string, token: string): Promise<void> {
    // Acknowledge lives on the v1 purchases.subscriptions resource.
    const url = `${API}/applications/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    if (!res.ok && res.status !== 409) throw new Error(`Play acknowledge returned ${res.status}`);
  }
}
