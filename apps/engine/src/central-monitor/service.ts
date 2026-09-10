import { TelegramSessionCryptoError, type TelegramSessionKeyRing } from "../../../../packages/telegram-session-crypto/src/index.ts";
import { TelegramAdapterError } from "../../../../packages/telegram-contract/src/index.ts";
import type { AutoCommentNotificationResponder } from "../auto-comment-matcher/notifier.ts";
import type { RuntimeAccountLeaseRepository } from "../runtime-leases/repository.ts";
import type {
  CentralMonitorDivision,
  CentralMonitorEvent,
  CentralMonitorLeaseContext,
  CentralMonitorRepository,
  CentralMonitorSource,
} from "./repository.ts";
import type {
  CentralMonitorPost,
  CentralMonitorTelegramClient,
  CentralMonitorTelegramClientFactory,
} from "./telegram-client.ts";

const LEASE_SECONDS = 90;
const HEARTBEAT_MILLISECONDS = 30_000;
const RETRY_MILLISECONDS = 30_000;
const BACKFILL_BATCH_SIZE = 100;
const PENDING_RECOVERY_LIMIT = 500;

type Deferred = Readonly<{ promise: Promise<void>; resolve(): void }>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

class CoalescingSignal {
  #pending = false;
  #waiter: (() => void) | null = null;

  notify(): void {
    if (!this.#waiter) { this.#pending = true; return; }
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter();
  }

  async wait(milliseconds: number): Promise<void> {
    if (this.#pending) { this.#pending = false; return; }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#waiter === finish) this.#waiter = null;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      timer.unref?.();
      this.#waiter = finish;
      if (this.#pending) { this.#pending = false; finish(); }
    });
  }
}

function errorCode(error: unknown): string {
  if (error instanceof TelegramAdapterError) return error.code;
  if (error instanceof TelegramSessionCryptoError) return error.code;
  return error instanceof Error && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.message)
    ? error.message
    : "CENTRAL_MONITOR_FAILED";
}

function matchedKeywords(content: string, division: CentralMonitorDivision): readonly string[] {
  const normalized = content.toLocaleLowerCase("id-ID");
  return Object.freeze(division.keywords.filter((keyword) => normalized.includes(keyword)));
}

function postLink(sourceChannelRef: string, providerPostId: number): string {
  return `https://t.me/${sourceChannelRef.replace(/^@/, "")}/${providerPostId}`;
}

function divisionAcceptsPostTime(division: CentralMonitorDivision, providerPostedAt: string | null): boolean {
  if (providerPostedAt === null) return true;
  const postedAt = Date.parse(providerPostedAt);
  const activatedAt = Date.parse(division.activatedAt);
  if (!Number.isFinite(postedAt) || !Number.isFinite(activatedAt)) return true;
  // Telegram timestamps have second precision while PostgreSQL activation
  // timestamps have finer precision. The small tolerance avoids dropping a
  // post created in the same second as activation.
  return postedAt >= activatedAt - 2_000;
}

type DivisionMatch = Readonly<{
  division: CentralMonitorDivision;
  keywords: readonly string[];
}>;

function matchingDivisions(
  source: CentralMonitorSource,
  post: Pick<CentralMonitorPost, "providerPostId" | "providerPostedAt" | "content">,
): readonly DivisionMatch[] {
  if (!post.content.trim()) return Object.freeze([]);
  const matches: DivisionMatch[] = [];
  for (const division of source.divisions) {
    if (division.startAfterPostId !== null && post.providerPostId <= division.startAfterPostId) continue;
    if (!divisionAcceptsPostTime(division, post.providerPostedAt)) continue;
    const keywords = matchedKeywords(post.content, division);
    if (keywords.length > 0) matches.push(Object.freeze({ division, keywords }));
  }
  return Object.freeze(matches);
}

export type CentralMonitorHandle = Readonly<{ stop(): Promise<void> }>;

export type CentralMonitorDependencies = Readonly<{
  repository: CentralMonitorRepository;
  accountLeases: RuntimeAccountLeaseRepository;
  sessionKeyRing: Pick<TelegramSessionKeyRing, "decrypt">;
  clientFactory: CentralMonitorTelegramClientFactory;
  notifier?: AutoCommentNotificationResponder;
}>;

class ConnectedMonitorSession {
  readonly #dependencies: CentralMonitorDependencies;
  readonly #lease: CentralMonitorLeaseContext;
  readonly #client: CentralMonitorTelegramClient;
  readonly #stopped = deferred();
  readonly #sourcesByPeer = new Map<string, CentralMonitorSource>();
  readonly #sourcesById = new Map<string, CentralMonitorSource>();
  readonly #postQueue: CentralMonitorPost[] = [];
  #stopRequested = false;
  #draining = false;
  #refreshTail: Promise<void> = Promise.resolve();

  constructor(dependencies: CentralMonitorDependencies, lease: CentralMonitorLeaseContext, client: CentralMonitorTelegramClient) {
    this.#dependencies = dependencies;
    this.#lease = lease;
    this.#client = client;
  }

  stop(): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    this.#stopped.resolve();
  }

  configurationChanged(): void {
    if (this.#stopRequested) return;
    this.#refreshTail = this.#refreshTail
      .then(async () => {
        const active = await this.#dependencies.repository.findActiveAccount();
        if (active?.accountId !== this.#lease.accountId) { this.stop(); return; }
        await this.#refreshSources();
        await this.#recoverPendingEvents();
      })
      .catch(() => {
        if (this.#stopRequested) return;
        const timer = setTimeout(() => this.configurationChanged(), RETRY_MILLISECONDS);
        timer.unref?.();
      });
  }

  async #recordConnected(): Promise<void> {
    if (!await this.#dependencies.repository.recordAccountResult({ ...this.#lease, result: "CONNECTED" })) {
      throw new Error("CENTRAL_MONITOR_FENCED");
    }
  }

  async #heartbeat(): Promise<void> {
    while (!this.#stopRequested) {
      await Promise.race([delay(HEARTBEAT_MILLISECONDS), this.#stopped.promise]);
      if (this.#stopRequested) return;
      try {
        const renewed = await this.#dependencies.accountLeases.renew({ ...this.#lease, leaseSeconds: LEASE_SECONDS });
        if (!renewed || renewed.fencingToken !== this.#lease.fencingToken) { this.stop(); return; }
        // A single global catch-up keeps Telegram's update state healthy after
        // a transient disconnect. This is deliberately not a per-user/source
        // history poll.
        await this.#client.catchUp();
      } catch { this.stop(); return; }
    }
  }

  #acceptPost(post: CentralMonitorPost): void {
    if (!this.#sourcesByPeer.has(post.providerPeerId)) return;
    this.#postQueue.push(post);
    if (!this.#draining) void this.#drainPostQueue();
  }

  async #drainPostQueue(): Promise<void> {
    this.#draining = true;
    try {
      while (!this.#stopRequested) {
        const post = this.#postQueue.shift();
        if (!post) break;
        const source = this.#sourcesByPeer.get(post.providerPeerId);
        if (!source) continue;
        try { await this.#ingest(source, post); }
        catch {
          this.#postQueue.unshift(post);
          await Promise.race([delay(1_000), this.#stopped.promise]);
        }
      }
    } finally {
      this.#draining = false;
      if (!this.#stopRequested && this.#postQueue.length > 0) void this.#drainPostQueue();
    }
  }

  async #notify(source: CentralMonitorSource, division: CentralMonitorDivision, event: CentralMonitorEvent, candidateId: string, keywords: readonly string[]): Promise<void> {
    if (!this.#dependencies.notifier || division.telegramUserId === null) return;
    try {
      const messageId = await this.#dependencies.notifier.sendCandidateNotification({
        chatId: division.telegramUserId,
        candidateId,
        channelLabel: source.sourceChannelRef,
        matchedKeywords: keywords,
        postLink: postLink(source.sourceChannelRef, event.providerPostId),
        postPreview: event.content,
        templateText: division.template.text,
      });
      await this.#dependencies.repository.recordNotification(candidateId, messageId);
    } catch {
      // Candidate durability is authoritative. Notification delivery remains
      // best-effort and never blocks other buyers matched by the same post.
    }
  }

  async #processEvent(event: CentralMonitorEvent, knownMatches?: readonly DivisionMatch[]): Promise<void> {
    const source = this.#sourcesById.get(event.sourceId);
    if (!source) {
      await this.#dependencies.repository.completeEvent({
        eventId: event.eventId,
        sourceId: event.sourceId,
        providerPostId: event.providerPostId,
      });
      return;
    }
    try {
      const notifications: Promise<void>[] = [];
      const matches = knownMatches ?? matchingDivisions(source, event);
      if (event.content.trim()) {
        for (const { division, keywords } of matches) {
          const candidate = await this.#dependencies.repository.createCandidate({
            source,
            division,
            providerPostId: event.providerPostId,
            content: event.content,
            matchedKeywords: keywords,
          });
          if (candidate.status === "PENDING_REVIEW") {
            notifications.push(this.#notify(source, division, event, candidate.candidateId, keywords));
          }
        }
      }
      await Promise.all(notifications);
      await this.#dependencies.repository.completeEvent({
        eventId: event.eventId,
        sourceId: source.sourceId,
        providerPostId: event.providerPostId,
      });
    } catch (error) {
      await this.#dependencies.repository.finishEvent(event.eventId, errorCode(error)).catch(() => undefined);
      const timer = setTimeout(() => this.configurationChanged(), RETRY_MILLISECONDS);
      timer.unref?.();
    }
  }

  async #ingest(source: CentralMonitorSource, post: CentralMonitorPost): Promise<void> {
    const matches = matchingDivisions(source, post);
    if (matches.length === 0) {
      // Unmatched traffic has no recovery consumer. Persist only the monotonic
      // checkpoint so a restart cannot replay it; durable event rows are
      // reserved for posts that can actually create buyer work.
      await this.#dependencies.repository.advanceCheckpoint({
        sourceId: source.sourceId,
        providerPostId: post.providerPostId,
      });
      return;
    }
    const event = await this.#dependencies.repository.enqueueEvent({
      sourceId: source.sourceId,
      providerPostId: post.providerPostId,
      content: post.content,
      providerPostedAt: post.providerPostedAt,
    });
    if (event) await this.#processEvent(event, matches);
    else await this.#dependencies.repository.advanceCheckpoint({ sourceId: source.sourceId, providerPostId: post.providerPostId });
  }

  async #backfill(source: CentralMonitorSource, afterPostId: number): Promise<void> {
    let checkpoint = afterPostId;
    while (!this.#stopRequested) {
      const posts = await this.#client.listNewPosts(source.sourceChannelRef, checkpoint, BACKFILL_BATCH_SIZE);
      if (posts.length === 0) return;
      for (const post of posts) {
        await this.#ingest(source, post);
        checkpoint = Math.max(checkpoint, post.providerPostId);
      }
      if (posts.length < BACKFILL_BATCH_SIZE) return;
    }
  }

  async #prepareSource(source: CentralMonitorSource): Promise<void> {
    try {
      const prepared = await this.#client.prepareSource(source.sourceChannelRef);
      await this.#dependencies.repository.markSourceReady({
        sourceId: source.sourceId,
        accountId: this.#lease.accountId,
        providerPeerId: prepared.providerPeerId,
      });

      if (source.lastPostId === null) {
        const current = Object.freeze({ ...source, providerPeerId: prepared.providerPeerId });
        this.#sourcesById.set(source.sourceId, current);
        this.#sourcesByPeer.set(prepared.providerPeerId, current);
        if (prepared.latestPostId !== null) {
          const recent = await this.#client.listRecentPosts(source.sourceChannelRef, BACKFILL_BATCH_SIZE);
          const activationWindow = recent.filter((post) => source.divisions.some((division) => divisionAcceptsPostTime(division, post.providerPostedAt)));
          if (activationWindow.length === 0) {
            await this.#dependencies.repository.advanceCheckpoint({ sourceId: source.sourceId, providerPostId: prepared.latestPostId });
          } else {
            for (const post of activationWindow) await this.#ingest(current, post);
          }
        }
        return;
      }
      const current = Object.freeze({ ...source, providerPeerId: prepared.providerPeerId });
      this.#sourcesById.set(source.sourceId, current);
      this.#sourcesByPeer.set(prepared.providerPeerId, current);
      await this.#backfill(current, source.lastPostId);
    } catch (error) {
      const telegramError = error instanceof TelegramAdapterError ? error : null;
      await this.#dependencies.repository.markSourceFailure({
        sourceId: source.sourceId,
        accountId: this.#lease.accountId,
        errorCode: errorCode(error),
        retryable: telegramError?.retryable ?? true,
      }).catch(() => undefined);
      if (telegramError?.retryable ?? true) {
        const timer = setTimeout(() => this.configurationChanged(), RETRY_MILLISECONDS);
        timer.unref?.();
      }
    }
  }

  async #refreshSources(): Promise<void> {
    const nextSources = await this.#dependencies.repository.loadSources(this.#lease.accountId);
    const wanted = new Set(nextSources.map((source) => source.sourceId));
    for (const [sourceId, previous] of this.#sourcesById) {
      if (wanted.has(sourceId)) continue;
      // Stop matching an ineligible source without leaving the Telegram
      // channel. Retaining membership avoids needless leave/join churn when a
      // buyer renews or re-enables the same target later.
      this.#sourcesById.delete(sourceId);
      if (previous.providerPeerId) this.#sourcesByPeer.delete(previous.providerPeerId);
    }
    for (const source of nextSources) {
      const existing = this.#sourcesById.get(source.sourceId);
      if (existing?.providerPeerId) {
        const refreshed = Object.freeze({ ...source, providerPeerId: existing.providerPeerId });
        this.#sourcesById.set(source.sourceId, refreshed);
        this.#sourcesByPeer.set(existing.providerPeerId, refreshed);
        continue;
      }
      await this.#prepareSource(source);
    }
  }

  async #recoverPendingEvents(): Promise<void> {
    const pending = await this.#dependencies.repository.listPendingEvents(PENDING_RECOVERY_LIMIT);
    for (const event of pending) {
      if (this.#stopRequested) return;
      await this.#processEvent(event);
    }
  }

  async run(): Promise<void> {
    this.#client.onPost((post) => this.#acceptPost(post));
    const heartbeat = this.#heartbeat();
    try {
      await this.#client.connect();
      await this.#recordConnected();
      await this.#refreshSources();
      await this.#recoverPendingEvents();
      await this.#client.catchUp();
      await this.#stopped.promise;
    } finally {
      this.stop();
      await heartbeat.catch(() => undefined);
      await this.#refreshTail.catch(() => undefined);
      await this.#client.disconnect().catch(() => undefined);
      await this.#dependencies.repository.recordAccountResult({ ...this.#lease, result: "DISCONNECTED" }).catch(() => false);
    }
  }
}

export async function startCentralAutoCommentMonitor(
  dependencies: CentralMonitorDependencies,
  input: Readonly<{ instanceId: string }>,
): Promise<CentralMonitorHandle> {
  const wake = new CoalescingSignal();
  let stopped = false;
  let activeSession: ConnectedMonitorSession | null = null;
  const subscription = await dependencies.repository.subscribeChanges(() => {
    activeSession?.configurationChanged();
    wake.notify();
  });

  const run = (async () => {
    while (!stopped) {
      let account: Readonly<{ accountId: string }> | null = null;
      try { account = await dependencies.repository.findActiveAccount(); }
      catch { /* retry on the bounded coordinator timer */ }
      if (!account) {
        await wake.wait(RETRY_MILLISECONDS);
        continue;
      }

      let acquisition;
      try {
        acquisition = await dependencies.accountLeases.acquire({
          accountId: account.accountId,
          leaseOwner: input.instanceId,
          leaseSeconds: LEASE_SECONDS,
        });
      } catch {
        await delay(RETRY_MILLISECONDS);
        continue;
      }
      if (acquisition.status === "HELD_BY_OTHER") {
        await wake.wait(RETRY_MILLISECONDS);
        continue;
      }

      const lease = Object.freeze({
        accountId: acquisition.lease.accountId,
        leaseOwner: acquisition.lease.leaseOwner,
        fencingToken: acquisition.lease.fencingToken,
      });
      let encryptedSession: Uint8Array | null = null;
      let client: CentralMonitorTelegramClient | null = null;
      try {
        const loaded = await dependencies.repository.loadAccountSession(lease);
        if (!loaded) throw new Error("CENTRAL_MONITOR_SESSION_UNAVAILABLE");
        encryptedSession = loaded.encryptedSession;
        const session = dependencies.sessionKeyRing.decrypt(
          { accountId: loaded.accountId, accountType: "MONITOR" },
          { ciphertext: encryptedSession, keyVersion: loaded.encryptionKeyVersion },
        );
        client = dependencies.clientFactory.create(session);
        activeSession = new ConnectedMonitorSession(dependencies, lease, client);
        await activeSession.run();
      } catch (error) {
        const telegramError = error instanceof TelegramAdapterError ? error : null;
        const cryptoError = error instanceof TelegramSessionCryptoError ? error : null;
        const result = telegramError?.code === "SESSION_REVOKED"
          ? "REVOKED" as const
          : telegramError?.code === "SESSION_CONFLICT" || (cryptoError && cryptoError.code !== "SESSION_KEY_NOT_FOUND")
            ? "DEGRADED" as const
            : "FAILED_RETRYABLE" as const;
        await dependencies.repository.recordAccountResult({
          ...lease,
          result,
          errorCode: errorCode(error),
          ...(result === "FAILED_RETRYABLE" ? { retryAfterSeconds: RETRY_MILLISECONDS / 1_000 } : {}),
        }).catch(() => false);
      } finally {
        encryptedSession?.fill(0);
        activeSession = null;
        await dependencies.accountLeases.release(lease).catch(() => false);
      }
      if (!stopped) await wake.wait(RETRY_MILLISECONDS);
    }
  })();

  return Object.freeze({
    stop: async () => {
      if (stopped) return await run;
      stopped = true;
      activeSession?.stop();
      wake.notify();
      await run;
      await subscription.close();
    },
  });
}
