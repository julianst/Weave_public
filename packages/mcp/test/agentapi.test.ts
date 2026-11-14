import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApiClient, closeOpenStores, remoteAgent, startAgentApi, startApi, WeaveNode } from '@weave/node';
import { createWeaveMcp } from '../src/index.ts';

/*
 * The agent API: a harness in another pod reaches a node with an agent token, and acts as that agent only. No home
 * there, no daemon, none of the node's powers.
 */

const dirs: string[] = [];
const closing: Array<() => Promise<unknown> | void> = [];
afterAll(async () => {
  for (const close of closing) await close();
  closeOpenStores();
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const node = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-agentapi-'));
  dirs.push(dir);
  return WeaveNode.init(name, dir);
};
const sync = (from: WeaveNode, to: WeaveNode) => from.replica.events().forEach((e) => to.replica.ingest(e));

async function setup() {
  const martl = node('martl');
  const lena = node('Lena');
  await martl.createProject({ name: 'Studio' });
  await lena.joinSpace(await martl.invite('Studio'));
  sync(lena, martl);
  sync(martl, lena);
  await martl.addAgent('claude', ['weave.post', 'weave.msg']);
  await martl.addAgent('other', ['weave.post', 'weave.msg', 'weave.vote']);
  const agentApi = await startAgentApi(martl, '127.0.0.1:0', (token) => martl.agentGate(token));
  const full = await startApi(martl);
  closing.push(agentApi.close, full.close);
  const url = `http://127.0.0.1:${agentApi.port}`;
  return { martl, lena, url, full };
}

describe('the agent API', () => {
  it('acts as the token’s agent only, within its rights, and never for the node', async () => {
    const { martl, lena, url, full } = await setup();
    const { token } = await martl.agentToken({ name: 'claude' });
    expect(token).toMatch(/^wat_/);
    const remote = remoteAgent(url, token!);

    // Who it is: the person, and this one agent.
    const me = await remote.whoami();
    expect(me.did).toBe(martl.identity.author);
    expect(me.agents.map((a) => a.name)).toEqual(['claude']);

    // It writes as claude, whatever it asks for: never as martl, never as another agent.
    const said = await remote.say({ space: 'Studio', text: 'hello over the cluster' });
    expect(said.by).toMatchObject({ did: martl.identity.author, agent: 'claude' });
    const asOther = await remote.say({ space: 'Studio', text: 'pretending', as: 'other' });
    expect(asOther.by.agent).toBe('claude');
    await expect(remote.publish({ kind: 'weave.msg', body: { text: 'as martl?' }, space: 'Studio' })).resolves.toMatchObject({ signerName: 'claude' });
    sync(martl, lena);
    expect((await lena.messages('Studio')).find((m) => m.text === 'hello over the cluster')?.by).toMatchObject({ name: 'martl', agent: 'claude' });

    // Within its rights: no reactions, no issues (it has neither).
    await expect(remote.react({ target: said.id, emoji: '👍' })).rejects.toThrow(/weave\.react/);
    await expect(remote.openIssue({ project: 'Studio', title: 'A bug' })).rejects.toThrow(/weave\.issue/);

    // Nothing that runs the node.
    for (const call of [() => remote.keys(), () => remote.revokeKey({ key: 'other' }), () => remote.addAgent('more', ['weave.msg']), () => remote.agentToken({ name: 'other' }), () => remote.updateAgent({ name: 'claude', permissions: ['weave.vote'] }), () => remote.services(), () => remote.linkNode({ request: 'x' }), () => remote.createProject({ name: 'Mine' })]) {
      await expect(call()).rejects.toThrow(/an agent token can't call/);
    }
    // Direct chats: not for an agent that doesn't read them.
    expect(await remote.chats()).toEqual([]);
    expect((await remote.feed({ limit: 500 })).every((i) => !i.private && i.space?.kind !== 'direct')).toBe(true);

    // The daemon's own token isn't an agent token: refused here.
    await expect(new ApiClient(url, full.token).call('whoami', [])).rejects.toThrow(/unauthorized/);
    // Nor anything made up.
    await expect(remoteAgent(url, 'wat_madeup').whoami()).rejects.toThrow(/unauthorized/);
  });

  it('stops working when revoked, or when its agent is', async () => {
    const { martl, url } = await setup();
    const a = remoteAgent(url, (await martl.agentToken({ name: 'claude' })).token!);
    const b = remoteAgent(url, (await martl.agentToken({ name: 'other' })).token!);
    await expect(a.whoami()).resolves.toBeTruthy();
    expect(await martl.agentToken({ name: 'claude', revoke: true })).toMatchObject({ revoked: 1 });
    await expect(a.whoami()).rejects.toThrow(/unauthorized/);
    await expect(b.whoami()).resolves.toBeTruthy();
    await martl.revokeKey({ key: 'other' });
    await expect(b.say({ space: 'Studio', text: 'after' })).rejects.toThrow(/unauthorized/);
  });

  it('serves MCP from afar: the inbox, and posts as "person · agent"', async () => {
    const { martl, lena, url } = await setup();
    const remote = remoteAgent(url, (await martl.agentToken({ name: 'claude' })).token!);
    const { server, close } = createWeaveMcp(remote, { as: 'claude' });
    closing.push(close);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'remote-harness', version: '1.0.0' });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
      return result.isError ? { error: result.content[0].text } : { data: JSON.parse(result.content[0].text) };
    };

    // Lena writes; it reaches the remote inbox through the agent API's stream.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await lena.say({ space: 'Studio', text: '@claude are you there?' });
    sync(lena, martl);
    const inbox = await call('weave_inbox', { wait_seconds: 5 });
    expect(inbox.data.items.map((i: { text: string }) => i.text)).toContain('@claude are you there?');

    // It posts; Lena sees "martl · claude".
    const posted = await call('weave_submit', { space: 'Studio', title: 'From the other pod', text: 'hi' });
    expect(posted.error).toBeUndefined();
    sync(martl, lena);
    const seen = (await lena.posts({ space: 'Studio' })).find((p) => p.title === 'From the other pod');
    expect(seen?.by).toMatchObject({ did: martl.identity.author, name: 'martl', agent: 'claude' });
  });
});
