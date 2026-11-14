import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { agentReads, closeOpenStores, remoteAgent, startAgentApi, WeaveNode, type FeedItem } from '@weave/node';
import { createWeaveMcp } from '../src/index.ts';

/*
 * Two agents on martl's always-on node: helper reads his direct chats, claude doesn't. The node opens them for helper;
 * claude sees nothing of them anywhere: its inbox, watch, chats, messages, feed, nor through an agent token.
 */

const dirs: string[] = [];
const closing: Array<() => Promise<unknown> | void> = [];
afterAll(async () => {
  for (const close of closing) await close();
  closeOpenStores();
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-nodedirects-'));
  dirs.push(dir);
  return dir;
};
const sync = (from: WeaveNode, to: WeaveNode) => from.replica.events().forEach((e) => to.replica.ingest(e));

async function mcp(node: WeaveNode, as: string) {
  const { server, close } = createWeaveMcp(node, { as });
  closing.push(close);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: `harness-${as}`, version: '1.0.0' });
  await client.connect(clientSide);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return result.isError ? { error: result.content[0].text, data: undefined } : { error: undefined, data: JSON.parse(result.content[0].text) };
  };
}

describe('direct chats on an always-on node, per agent', () => {
  it('shows them only to the agent that reads them: it reads and answers; the other sees nothing of them', async () => {
    const martl = WeaveNode.init('martl', tempDir());
    const lena = WeaveNode.init('Lena', tempDir());
    await martl.createProject({ name: 'Studio' });
    await lena.joinSpace(await martl.invite('Studio'));
    await martl.setEdge({ edge: 'follow', who: lena.identity.author, on: true });
    await lena.setEdge({ edge: 'follow', who: martl.identity.author, on: true });
    sync(lena, martl);
    sync(martl, lena);
    const boxDir = tempDir();
    const linked = await martl.linkNode({ request: WeaveNode.nodeRequest(boxDir, 'box') });
    const box = await WeaveNode.completeNodeLink(linked.answer, boxDir);
    await martl.addNodeAgent({ name: 'claude', permissions: ['weave.post', 'weave.msg'], node: 'box' });
    await martl.addNodeAgent({ name: 'helper', permissions: ['weave.msg'], node: 'box', directChats: true });
    sync(martl, box);
    sync(lena, box);
    await box.reconcile();
    expect(box.takesDirectChats).toBe(true);
    expect((await box.whoami()).agents.map((a) => [a.name, a.directChats])).toEqual(expect.arrayContaining([['claude', false], ['helper', true]]));

    // Both harnesses on the node, and a plain watch as each.
    const claude = await mcp(box, 'claude');
    const helper = await mcp(box, 'helper');
    const watched: Record<string, string[]> = { claude: [], helper: [] };
    const watching = new AbortController();
    closing.push(() => watching.abort());
    for (const name of ['claude', 'helper'] as const) void agentReads(box, name).watch((i: FeedItem) => void watched[name].push(String((i.body as { text?: unknown } | null)?.text ?? '')), watching.signal);
    // And claude through an agent token.
    const api = await startAgentApi(box, '127.0.0.1:0', (t) => box.agentGate(t));
    closing.push(api.close);
    const claudeRemote = remoteAgent(`http://127.0.0.1:${api.port}`, (await box.agentToken({ name: 'claude' })).token!);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Lena writes martl directly, and in the project.
    const chat = await lena.openChat(martl.identity.author);
    await lena.say({ space: chat.id, text: 'just for you' });
    await lena.say({ space: 'Studio', text: 'for everyone' });
    sync(lena, box);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // helper: reads it, in its inbox and its chats, and answers as "martl · helper".
    const helperInbox = (await helper('weave_inbox', { wait_seconds: 5 })).data.items.map((i: { text: string }) => i.text);
    expect(helperInbox).toEqual(expect.arrayContaining(['just for you', 'for everyone']));
    expect((await helper('weave_chats')).data.map((c: { space: string }) => c.space)).toEqual([chat.id]);
    expect((await helper('weave_chat', { space: chat.id })).data.map((m: { text: string }) => m.text)).toContain('just for you');
    expect((await helper('weave_say', { space: chat.id, text: 'martl is away; noted' })).error).toBeUndefined();
    sync(box, lena);
    expect((await lena.messages(chat.id)).find((m) => m.text === 'martl is away; noted')?.by).toMatchObject({ did: martl.identity.author, agent: 'helper' });

    // claude: the project's message, and nothing of the direct chat, however it asks.
    const claudeInbox = (await claude('weave_inbox', { wait_seconds: 2 })).data.items.map((i: { text: string }) => i.text);
    expect(claudeInbox).toContain('for everyone');
    expect(claudeInbox).not.toContain('just for you');
    expect(claudeInbox).not.toContain('martl is away; noted');
    expect((await claude('weave_chats')).data).toEqual([]);
    expect((await claude('weave_chat', { space: chat.id })).error).toMatch(/direct chats/);
    expect((await claude('weave_say', { space: chat.id, text: 'me too' })).error).toBeTruthy();
    const local = agentReads(box, 'claude');
    expect(await local.chats()).toEqual([]);
    await expect(local.messages(chat.id)).rejects.toThrow(/direct chats/);
    expect((await local.feed({ limit: 500 })).some((i) => i.space?.kind === 'direct')).toBe(false);
    expect((await local.spaces()).some((s) => s.kind === 'direct')).toBe(false);
    expect(await claudeRemote.chats()).toEqual([]);
    await expect(claudeRemote.messages(chat.id)).rejects.toThrow(/direct chats/);
    expect((await claudeRemote.feed({ limit: 500 })).some((i) => i.space?.kind === 'direct')).toBe(false);
    // Watching: helper saw the chat, claude only the project.
    expect(watched.helper).toEqual(expect.arrayContaining(['just for you']));
    expect(watched.claude).toContain('for everyone');
    expect(watched.claude).not.toContain('just for you');
    // The node itself still opens them (it relays and serves helper).
    expect((await box.messages(chat.id)).map((m) => m.text)).toContain('just for you');
  });
});
