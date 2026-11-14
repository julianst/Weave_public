import type { Did } from '@weave/core';
import type { Backend, ChatInfo, FeedItem, RpcMethod } from './backend.ts';

/*
 * Agent tokens (`weave agent token <name>`): a bearer token bound to one agent key, for a harness that reaches a node
 * over the network (the agent API, `weave daemon --agent-api`) instead of through its home. A request with one acts as
 * that agent and nothing else: every write is signed by the agent (`as` is set here, whatever the caller sent), its
 * rights are checked as for any agent, and it reads what the agent reads: the person's groups, projects and
 * communities, and their direct chats only for an agent that reads them (one on an always-on node with direct chats
 * on). Nothing that runs the node: keys, devices, services, settings, other agents, links, pairing.
 */

/** Who a token speaks for. */
export interface AgentGrant {
  name: string;
  did: Did;
  /** It reads and answers the person's direct chats. */
  directChats: boolean;
}

/** Writes: their first argument is an input object; its `as` is the token's agent, always. */
const WRITES = ['publish', 'submit', 'editPost', 'deletePost', 'upvote', 'say', 'deleteMessage', 'react', 'startThread', 'reply', 'openIssue', 'claimIssue', 'setIssueStatus', 'vote', 'requestPermission', 'requestHand'] as const satisfies readonly RpcMethod[];

/** Reads, and storing a file to attach (no event, nothing signed). */
const READS = ['whoami', 'feed', 'spaces', 'posts', 'post', 'members', 'boards', 'project', 'threads', 'issues', 'proposals', 'messages', 'channels', 'chats', 'openChat', 'profile', 'imprint', 'tiers', 'blob', 'putBlob', 'putFile', 'agentBlocked'] as const satisfies readonly RpcMethod[];

/** Every method an agent token may call, one by one: a new method stays off until it's added here on purpose. */
export const AGENT_TOKEN_METHODS: readonly RpcMethod[] = [...WRITES, ...READS];

const isWrite = (method: string): boolean => (WRITES as readonly string[]).includes(method);

const directsOff = () => new Error("this agent doesn't read your direct chats");

/** Is this item somewhere the agent doesn't read: a direct chat (without the option), or sealed to the person alone? */
const hidden = (item: { space?: { kind?: string }; private?: true }, grant: AgentGrant): boolean => item.private === true || (item.space?.kind === 'direct' && !grant.directChats);

/**
 * The node as one agent's token sees it: only AGENT_TOKEN_METHODS, writes as that agent, and nothing of the person's
 * direct chats unless the agent reads them. Returns undefined for a method the token may not call.
 */
export function agentCall(backend: Backend, grant: AgentGrant, method: string, args: unknown[]): Promise<unknown> | undefined {
  if (!AGENT_TOKEN_METHODS.includes(method as RpcMethod)) return undefined;
  const call = (m: RpcMethod, a: unknown[]) => (backend[m] as (...x: unknown[]) => Promise<unknown>).apply(backend, a);
  /** A space reference that names one of the person's direct chats (its id, the other person's name or key). */
  const isChat = async (ref: unknown): Promise<boolean> => {
    if (typeof ref !== 'string') return false;
    const chats = await backend.chats();
    const r = ref.toLowerCase();
    return chats.some((c: ChatInfo) => c.space.id === ref || c.peer.did === ref || c.space.name.toLowerCase() === r || c.peer.name?.toLowerCase() === r);
  };
  return (async () => {
    if (isWrite(method)) {
      const input: Record<string, unknown> = { ...((args[0] ?? {}) as Record<string, unknown>), as: grant.name };
      if (!grant.directChats && (await isChat(input.space))) throw directsOff();
      return call(method as RpcMethod, [input, ...args.slice(1)]);
    }
    switch (method) {
      case 'whoami': {
        const me = await backend.whoami();
        return { ...me, agents: me.agents.filter((a) => a.name === grant.name && a.did === grant.did) };
      }
      case 'feed':
        return ((await call('feed', args)) as FeedItem[]).filter((i) => !hidden(i, grant));
      case 'spaces':
        return ((await call('spaces', args)) as Array<{ kind?: string }>).filter((s) => grant.directChats || s.kind !== 'direct');
      case 'posts':
        return ((await call('posts', args)) as Array<{ space?: { kind?: string } }>).filter((p) => !hidden(p, grant));
      case 'post': {
        const post = (await call('post', args)) as { space?: { kind?: string } };
        if (hidden(post, grant)) throw directsOff();
        return post;
      }
      case 'agentBlocked':
        return backend.agentBlocked(grant.name);
      case 'chats':
        return grant.directChats ? call('chats', args) : [];
      case 'openChat':
        if (!grant.directChats) throw directsOff();
        return call('openChat', args);
      case 'messages':
      case 'channels':
        if (!grant.directChats && (await isChat(args[0]))) throw directsOff();
        return call(method, args);
      default:
        return call(method as RpcMethod, args);
    }
  })();
}

/** The live stream as the agent sees it. */
export function agentWatch(backend: Backend, grant: AgentGrant, onItem: (item: FeedItem) => void, signal: AbortSignal): Promise<void> {
  return backend.watch((item) => {
    if (!hidden(item, grant)) onItem(item);
  }, signal);
}
