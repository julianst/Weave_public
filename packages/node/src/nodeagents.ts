import { WeaveError, b64u, boxTo, createSubKey, delegation, type Did, type Json } from '@weave/core';
import { readJson, writeJson } from './home.ts';
import { AGENT_NAME, removeAgent, saveAgent, type AgentKey } from './keystore.ts';
import type { AgentInfo } from './backend.ts';
import type { ServicesHost } from './node.ts';
import type { Services } from './services.ts';

/*
 * Agents on always-on nodes: an agent made on one of your computers, its key sealed to one of your always-on nodes and
 * never kept on the computer. The node signs with it under the agent's own name ("martl · claude"); its own key still
 * signs rooms only. Optionally the agent reads and answers your direct chats there too: then the node takes them.
 */

/**
 * Sealed to yourself, by one of your computers: an agent for one of your always-on nodes. Its name and rights in the
 * clear for your devices; its key in a box only that node opens. Later ones change its rights or remove it.
 */
export const KIND_AGENT_HANDOVER = 'weave.agent.handover';

export interface AgentHandover {
  id: string;
  agent: string;
  /** The always-on node's key it's for. */
  node: Did;
  /** The agent's own key. */
  did: Did;
  permissions: string[];
  /** It reads and answers your direct chats on that node. */
  directChats?: boolean;
  /** For the node only: the agent's key (when new). */
  box?: Json;
  removed?: true;
}

/** What a node keeps of the agents handed to it (besides their keys, which are in agents/): which read direct chats. */
type Kept = Record<string, { did: Did; directChats?: boolean }>;

export class NodeAgents {
  readonly h: ServicesHost;
  readonly #services: () => Services;
  readonly #forgetDirects: () => void;
  #kept?: Kept;
  /** Whether direct chats were taken here when last looked. */
  #direct?: boolean;

  constructor(h: ServicesHost, services: () => Services, forgetDirects: () => void) {
    this.h = h;
    this.#services = services;
    this.#forgetDirects = forgetDirects;
  }

  /** The latest handover of each agent still on a node (removed ones left out), as your devices read them. */
  handedAgents(): Map<string, AgentHandover> {
    const latest = new Map<string, AgentHandover>();
    for (const d of this.h.decodeAll().filter((x) => x.private && x.inner.kind === KIND_AGENT_HANDOVER).sort((a, b) => a.event.time.localeCompare(b.event.time))) {
      const body = d.inner.body as unknown as AgentHandover;
      if (typeof body?.agent !== 'string') continue;
      if (body.removed) latest.delete(body.agent);
      else latest.set(body.agent, { ...body, id: d.id });
    }
    return latest;
  }

  /** The agent on a node by its key, if it's one (and not removed). */
  byKey(did: Did): AgentHandover | undefined {
    return [...this.handedAgents().values()].find((h) => h.did === did);
  }

  info(h: AgentHandover): AgentInfo {
    return { name: h.agent, did: h.did, permissions: h.permissions, node: { did: h.node, name: this.#nodeName(h.node) }, ...(h.directChats ? { directChats: true } : {}) };
  }

  #nodeName(did: Did): string {
    const grant = this.h.replica.authority.grant(did);
    return grant?.name?.replace(/^node:/, '') ?? did;
  }

  /**
   * On one of your computers: a new agent for an always-on node. Its key is made here, its rights signed by this
   * device, and the key goes to that node sealed, for its eyes only: this computer keeps none of it.
   */
  add(input: { name: string; permissions: string[]; node: string; directChats?: boolean }): AgentInfo {
    if (this.h.isLinkedNode) throw new Error('add agents for your always-on node from one of your own computers');
    const name = input.name.trim();
    if (!AGENT_NAME.test(name)) throw new Error('agent names use lowercase letters, digits and dashes');
    const permissions = [...new Set(input.permissions.map((p) => p.trim()).filter(Boolean))];
    if (permissions.includes('*')) throw new WeaveError('daemon.agent.all.permissions', undefined, "agents can't get every permission: name the kinds they may sign");
    if (!permissions.length) throw new Error('name the kinds it may sign, e.g. weave.post,weave.reply,weave.msg');
    const services = this.#services();
    const taken = this.h.agents.some((a) => a.name === name) || this.handedAgents().has(name) || services.handedOver().has(name) || services.storedServices().some((s) => s.name === name);
    if (taken) throw new Error(`agent "${name}" already exists`);
    const node = services.nodeKey(input.node);
    const key = createSubKey(this.h.identity.author);
    this.h.replica.write(this.h.identity, delegation(key.did, 'agent', permissions, name));
    const handover: Omit<AgentHandover, 'id'> = {
      agent: name,
      node: node.did,
      did: key.did,
      permissions,
      ...(input.directChats ? { directChats: true } : {}),
      box: boxTo(node.did, { secretKey: b64u.encode(key.keys.secretKey), publicKey: b64u.encode(key.keys.publicKey) }) as unknown as Json,
    };
    this.h.replica.write(this.h.identity, this.h.sealForSelf({ kind: KIND_AGENT_HANDOVER, body: handover as unknown as Json }));
    return this.info({ ...handover, id: '' });
  }

  /** A change to an agent on a node: other rights, direct chats on or off, or gone (after it was revoked). */
  change(before: AgentHandover, change: { permissions?: string[]; directChats?: boolean; removed?: true }): AgentInfo {
    const { id: _id, box: _box, directChats: wasDirect, ...rest } = before;
    const permissions = change.permissions ? [...new Set(change.permissions.map((p) => p.trim()).filter(Boolean))] : before.permissions;
    if (permissions.includes('*')) throw new WeaveError('daemon.agent.all.permissions', undefined, "agents can't get every permission: name the kinds they may sign");
    if (change.permissions) this.h.replica.write(this.h.identity, delegation(before.did, 'agent', permissions, before.agent));
    const directChats = change.directChats ?? wasDirect;
    const after: Omit<AgentHandover, 'id'> = { ...rest, permissions, ...(directChats ? { directChats: true } : {}), ...(change.removed ? { removed: true as const } : {}) };
    this.h.replica.write(this.h.identity, this.h.sealForSelf({ kind: KIND_AGENT_HANDOVER, body: after as unknown as Json }));
    return this.info({ ...after, id: '' });
  }

  // On the always-on node.

  #keptFile(): string {
    return `${this.h.home.dir}/node-agents.json`;
  }

  #loadKept(): Kept {
    if (!this.#kept) this.#kept = readJson<Kept>(this.#keptFile()) ?? {};
    return this.#kept;
  }

  /** On a node: an agent here reads your direct chats, so the node takes them (derives and decrypts them). */
  directChatsHere(): boolean {
    const kept = this.#loadKept();
    return Object.entries(kept).some(([name, k]) => k.directChats && this.h.agents.some((a) => a.name === name && a.did === k.did) && this.h.replica.authority.grant(k.did)?.revokedAfter === undefined);
  }

  /** On a node: this agent (by name) was handed over for your direct chats. */
  readsDirectChats(name: string): boolean {
    const k = this.#loadKept()[name];
    return !!k?.directChats && this.h.agents.some((a) => a.name === name && a.did === k.did);
  }

  /** On an always-on node: take the agents handed to it, change their rights, or drop their keys. Each handover once. */
  take(): number {
    if (!this.h.isLinkedNode) return 0;
    const appliedFile = `${this.h.home.dir}/agent-handovers.json`;
    const applied = new Set<string>(readJson<string[]>(appliedFile) ?? []);
    const mine = this.h.decodeAll()
      .filter((d) => d.private && d.inner.kind === KIND_AGENT_HANDOVER && !applied.has(d.id) && (d.inner.body as { node?: unknown } | null)?.node === this.h.identity.did)
      .sort((a, b) => a.event.time.localeCompare(b.event.time));
    const kept = { ...this.#loadKept() };
    let changed = 0;
    for (const d of mine) {
      applied.add(d.id);
      const h = d.inner.body as unknown as AgentHandover;
      if (typeof h?.agent !== 'string') continue;
      const held = this.h.agents.find((a) => a.name === h.agent);
      if (h.removed) {
        if (!held || held.did !== h.did) continue;
        this.h.agents = this.h.agents.filter((a) => a.name !== h.agent);
        removeAgent(this.h.home, h.agent);
        delete kept[h.agent];
        changed++;
        continue;
      }
      if (!held) {
        const opened = h.box ? this.#services().openHandoverBox(h.box) : undefined;
        if (typeof opened?.secretKey !== 'string' || typeof opened.publicKey !== 'string') continue;
        const key: AgentKey = { author: this.h.identity.author, did: h.did, keys: { secretKey: b64u.decode(opened.secretKey), publicKey: b64u.decode(opened.publicKey) }, name: h.agent, permissions: h.permissions };
        saveAgent(this.h.home, key);
        this.h.agents = [...this.h.agents, key];
      } else if (held.did === h.did && JSON.stringify(held.permissions) !== JSON.stringify(h.permissions)) {
        const updated = { ...held, permissions: h.permissions };
        saveAgent(this.h.home, updated);
        this.h.agents = this.h.agents.map((a) => (a.name === h.agent ? updated : a));
      } else if (held.did !== h.did) continue;
      kept[h.agent] = { did: h.did, ...(h.directChats ? { directChats: true } : {}) };
      changed++;
    }
    // Keys revoked meanwhile (on a computer that told no node yet): dropped here all the same.
    for (const [name, k] of Object.entries(kept)) {
      if (this.h.replica.authority.grant(k.did)?.revokedAfter === undefined) continue;
      this.h.agents = this.h.agents.filter((a) => !(a.name === name && a.did === k.did));
      removeAgent(this.h.home, name);
      delete kept[name];
      changed++;
    }
    if (mine.length) writeJson(appliedFile, [...applied]);
    if (changed) {
      writeJson(this.#keptFile(), kept);
      this.#kept = kept;
    }
    // Direct chats taken here, or let go (also when their agent was revoked): derived again, or not at all.
    const direct = this.directChatsHere();
    if (this.#direct !== undefined && direct !== this.#direct) this.#forgetDirects();
    this.#direct = direct;
    return changed;
  }
}
