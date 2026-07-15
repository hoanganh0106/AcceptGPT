import { randomUUID } from 'node:crypto';
import { DomainError } from './domain-error';
import type { SessionCredentials } from './session-input';

export type MembershipState = 'member' | 'not-member' | 'unknown';
export interface JoinAttempt { membership: MembershipState; requestAccepted: boolean; inviteAccepted: boolean; }
export interface JoinClient { requestJoin(credentials: SessionCredentials, workspaceId: string): Promise<JoinAttempt>; verifyMembership(credentials: SessionCredentials, workspaceId: string): Promise<MembershipState>; }
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface JoinClientOptions { baseUrl: string; timeoutMs: number; maxRetries: number; retryBackoffMs: number; userAgent?: string; }

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME_HINTS = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
const UPSTREAM_STATUS_REASONS: Record<number, string> = {
  401: 'auth_failed_or_expired',
  402: 'workspace_inactive',
  403: 'seat_or_blocked',
  404: 'wrong_workspace_id',
  409: 'already_requested_or_member',
  422: 'workspace_inactive',
  429: 'rate_limited',
  500: 'workspace_missing',
};
const json = async (response: Response): Promise<unknown> => { try { return await response.json() as unknown; } catch { return null; } };
const contains = (value: unknown, needle: string): boolean => JSON.stringify(value)?.toLowerCase().includes(needle.toLowerCase()) ?? false;
const upstreamDetail = (status: number): string => `${status}:${UPSTREAM_STATUS_REASONS[status] ?? 'upstream_error'}`;

export class ChatGptJoinClient implements JoinClient {
  private readonly origin: string;

  constructor(
    private readonly options: JoinClientOptions,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly uuid: () => string = randomUUID,
  ) {
    this.origin = new URL(options.baseUrl).origin;
  }

  async requestJoin(credentials: SessionCredentials, workspaceId: string): Promise<JoinAttempt> {
    const deviceId = this.uuid();
    const request = await this.call('POST', `/backend-api/accounts/${workspaceId}/invites/request`, credentials, deviceId);
    const requestAccepted = request.ok || request.status === 409;
    const accept = await this.call('POST', `/backend-api/accounts/${workspaceId}/invites/accept`, credentials, deviceId);
    const inviteAccepted = accept.ok || accept.status === 409;
    const membership = await this.verifyMembership(credentials, workspaceId, deviceId);
    if (!requestAccepted && !inviteAccepted && membership !== 'member') {
      throw new DomainError('JOIN_REJECTED', 'Lời mời không được chấp nhận.', `request:${upstreamDetail(request.status)},accept:${upstreamDetail(accept.status)}`);
    }
    return { membership, requestAccepted, inviteAccepted };
  }

  async verifyMembership(credentials: SessionCredentials, workspaceId: string, deviceId = this.uuid()): Promise<MembershipState> {
    for (const endpoint of ['/backend-api/accounts/check/v4-2023-04-27']) {
      const response = await this.call('GET', endpoint, credentials, deviceId);
      if (!response.ok) continue;
      const body = await json(response);
      if (contains(body, workspaceId)) return 'member';
    }
    return 'not-member';
  }

  private requestHeaders(credentials: SessionCredentials, deviceId: string): Record<string, string> {
    return {
      accept: '*/*',
      authorization: `Bearer ${credentials.accessToken}`,
      'content-type': 'application/json',
      'oai-device-id': deviceId,
      'oai-language': 'en-US',
      'user-agent': this.options.userAgent ?? DEFAULT_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      origin: this.origin,
      referer: `${this.origin}/`,
      'sec-ch-ua': CHROME_HINTS,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    };
  }

  private async call(method: string, path: string, credentials: SessionCredentials, deviceId = this.uuid()): Promise<Response> {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= Math.max(1, this.options.maxRetries); attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        try {
          const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
            method,
            signal: controller.signal,
            headers: this.requestHeaders(credentials, deviceId),
            ...(method === 'POST' ? { body: '' } : {}),
          });
          clearTimeout(timer);
          lastStatus = response.status;
          if (!response.ok) console.warn('[ChatGptJoinClient] upstream non-2xx', { path, status: response.status });
          if (response.status === 429 || response.status >= 500) {
            if (attempt < this.options.maxRetries) {
              await this.sleep(this.options.retryBackoffMs);
              continue;
            }
          }
          return response;
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        if (attempt >= this.options.maxRetries) throw new DomainError('UPSTREAM_TIMEOUT', 'ChatGPT tạm thời không phản hồi.', `attempt:${attempt}`);
        await this.sleep(this.options.retryBackoffMs);
      }
    }
    throw new DomainError('UPSTREAM_TIMEOUT', 'ChatGPT tạm thời không phản hồi.', `status:${lastStatus}`);
  }
}
