import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { b64u } from '@weave/core';
import { resolveHome, WeaveNode, closeOpenStores } from '../src/index.ts';
import { loadAgents } from '../src/keystore.ts';

/*
 * An agent on an always-on node: made on a computer, its key sealed to the node and kept nowhere else. It signs there
 * under its own name ("martl · claude"), with exactly its rights; the node's own key still signs rooms only. Direct
 * chats stay off the node unless that agent is to read them.
 */

const dirs: string[] = [];
const nodes: WeaveNode[] = [];
afterAll(async () => {
  for (const node of nodes) await node.close().catch(() => {});
  closeOpenStores();
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'weave-nodeagent-'));
  dirs.push(dir);
  return dir;
};
const sync = (from: WeaveNode, to: WeaveNode) => from.replica.events().forEach((e) => to.replica.ingest(e));
const person = (name: string, dir = tempDir()) => {
  const node = WeaveNode.init(name, dir);
  nodes.push(node);
  return { node, dir };
};

/** Every file under a folder, as bytes. */
const files = (dir: string): Buffer[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [readFileSync(path)];
  });

async function setUp() {
  const { node: martl, dir: martlDir } = person('martl');
  const { node: lena } = person('Lena');
  await martl.createProject({ name: 'Studio' });
  await lena.joinSpace(await martl.invite('Studio'));
  sync(lena, martl);
  sync(martl, lena);
  // Friends, so they have a direct chat.
  await martl.setEdge({ edge: 'follow', who: lena.identity.author, on: true });
  await lena.setEdge({ edge: 'follow', who: martl.identity.author, on: true });
  sync(martl, lena);
  sync(lena, martl);
  const boxDir = tempDir();
  const linked = await martl.linkNode({ request: WeaveNode.nodeRequest(boxDir, 'box') });
  const box = await WeaveNode.completeNodeLink(linked.answer, boxDir);
  nodes.push(box);
  sync(martl, box);
  sync(lena, box);
  return { martl, martlDir, lena, box, boxDir };
}

describe('an agent on an always-on node', () => {
  it('is handed over sealed, signs there as "person · agent" within its rights, and goes when revoked', async () => {
    const { martl, martlDir, lena, box, boxDir } = await setUp();

    const claude = await martl.addNodeAgent({ name: 'claude', permissions: ['weave.post', 'weave.reply', 'weave.msg'], node: 'box' });
    expect(claude).toMatchObject({ name: 'claude', permissions: ['weave.post', 'weave.reply', 'weave.msg'], node: { name: 'box' } });
    expect(claude.directChats).toBeUndefined();
    // Listed on the computer as on the node, with its rights; its delegation is martl's, named after it.
    expect((await martl.keys()).find((k) => k.name === 'claude')).toMatchObject({ role: 'agent', did: claude.did, node: { name: 'box' }, permissions: ['weave.post', 'weave.reply', 'weave.msg'] });
    expect(martl.replica.authority.grant(claude.did)).toMatchObject({ role: 'agent', name: 'claude', permissions: ['weave.post', 'weave.reply', 'weave.msg'] });
    // Not usable here: the computer holds no key for it.
    expect((await martl.whoami()).agents.map((a) => a.name)).not.toContain('claude');
    await expect(martl.say({ space: 'Studio', text: 'from the computer', as: 'claude' })).rejects.toThrow();
    // Another of that name, here or on a node, is refused.
    await expect(martl.addNodeAgent({ name: 'claude', permissions: ['weave.msg'], node: 'box' })).rejects.toThrow(/already exists/);
    await expect(martl.addNodeAgent({ name: 'other', permissions: ['weave.msg'], node: 'nowhere' })).rejects.toThrow(/no always-on node/);

    // The node takes it.
    sync(martl, box);
    expect(await box.reconcile()).toBeGreaterThan(0);
    expect((await box.whoami()).agents).toEqual([{ name: 'claude', did: claude.did, permissions: ['weave.post', 'weave.reply', 'weave.msg'], directChats: false }]);

    // The key is on the node only: nothing in martl's home has it, not even sealed in a file.
    const secret = loadAgents(resolveHome(boxDir)).find((a) => a.name === 'claude')!.keys.secretKey;
    expect(loadAgents(resolveHome(martlDir)).map((a) => a.name)).not.toContain('claude');
    expect(existsSync(join(martlDir, 'agents', 'claude.json'))).toBe(false);
    for (const needle of [b64u.encode(secret), Buffer.from(secret).toString('hex'), Buffer.from(secret).toString('base64')]) {
      expect(files(martlDir).some((bytes) => bytes.includes(needle))).toBe(false);
    }
    expect(files(martlDir).some((bytes) => bytes.includes(Buffer.from(secret)))).toBe(false);

    // It posts and chats in martl's project; Lena sees "martl · claude", signed by the agent's key.
    const post = await box.submit({ space: 'Studio', title: 'Nightly notes', text: 'all green', as: 'claude' });
    await box.say({ space: 'Studio', text: 'hello from the box', as: 'claude' });
    sync(box, lena);
    const seen = (await lena.posts({ space: 'Studio' })).find((p) => p.id === post.id);
    expect(seen?.by).toMatchObject({ did: martl.identity.author, name: 'martl', agent: 'claude' });
    const said = (await lena.messages('Studio')).find((m) => m.text === 'hello from the box');
    expect(said?.by).toMatchObject({ did: martl.identity.author, name: 'martl', agent: 'claude' });
    const items = await lena.feed({ space: 'Studio', kinds: ['weave.msg'] });
    expect(items.find((i) => (i.body as { text?: string }).text === 'hello from the box')?.signer).toBe(claude.did);

    // The node's own key still signs nothing but rooms.
    await expect(box.say({ space: 'Studio', text: 'written by the box' })).rejects.toThrow(/always-on node/);
    // The agent stays within its rights.
    await expect(box.vote({ proposal: 'nothing', choice: 'yes', as: 'claude' })).rejects.toThrow();
    await expect(box.publish({ kind: 'weave.issue', body: { title: 'x' }, space: 'Studio', as: 'claude' })).rejects.toThrow(/weave\.issue/);

    // Its rights change on the computer; the node follows.
    await martl.updateAgent({ name: 'claude', permissions: ['weave.msg'] });
    sync(martl, box);
    await box.reconcile();
    expect((await box.whoami()).agents[0]?.permissions).toEqual(['weave.msg']);
    await expect(box.submit({ space: 'Studio', title: 'Not any more', as: 'claude' })).rejects.toThrow();

    // Revoked: Lena hears of it first; what the node's agent signs after that counts nowhere.
    await martl.revokeKey({ key: 'claude' });
    sync(martl, lena);
    await box.say({ space: 'Studio', text: 'after the revoke', as: 'claude' });
    sync(box, lena);
    expect((await lena.messages('Studio')).map((m) => m.text)).not.toContain('after the revoke');
    expect((await martl.keys()).find((k) => k.did === claude.did)?.revokedAfter).toBeDefined();
    // And the node drops the key.
    sync(martl, box);
    await box.reconcile();
    expect((await box.whoami()).agents).toEqual([]);
    expect(existsSync(join(boxDir, 'agents', 'claude.json'))).toBe(false);
  });

  it("keeps direct chats off the node, unless its agent is to read them: then it reads and answers them", async () => {
    const { martl, lena, box } = await setUp();
    const chat = await lena.openChat(martl.identity.author);
    await lena.say({ space: chat.id, text: 'just for you' });
    sync(lena, martl);
    sync(lena, box);
    expect((await martl.messages(chat.id)).map((m) => m.text)).toContain('just for you');

    // Off (the default): the node doesn't take them, also with an agent there.
    await martl.addNodeAgent({ name: 'claude', permissions: ['weave.post', 'weave.reply', 'weave.msg'], node: 'box' });
    sync(martl, box);
    await box.reconcile();
    expect(box.takesDirectChats).toBe(false);
    expect(await box.chats()).toEqual([]);
    expect((await box.messages(chat.id).catch(() => [])).map((m) => m.text)).not.toContain('just for you');
    expect((await box.feed({ kinds: ['weave.msg'] })).map((i) => (i.body as { text?: string }).text)).not.toContain('just for you');

    // An agent for direct chats: the node reads them, and the agent answers under its own key.
    const helper = await martl.addNodeAgent({ name: 'helper', permissions: ['weave.msg'], node: 'box', directChats: true });
    expect(helper.directChats).toBe(true);
    expect((await martl.keys()).find((k) => k.name === 'helper')).toMatchObject({ node: { name: 'box' }, directChats: true });
    sync(martl, box);
    await box.reconcile();
    expect(box.takesDirectChats).toBe(true);
    const chats = await box.chats();
    expect(chats.map((c) => c.peer.did)).toEqual([lena.identity.author]);
    expect((await box.messages(chat.id)).map((m) => m.text)).toContain('just for you');
    await box.say({ space: chat.id, text: 'martl is away, I note it for him', as: 'helper' });
    // Only an agent for direct chats answers there.
    await expect(box.say({ space: chat.id, text: 'me too', as: 'claude' })).rejects.toThrow(/direct chats/);
    sync(box, lena);
    sync(box, martl);
    const answer = (await lena.messages(chat.id)).find((m) => m.text === 'martl is away, I note it for him');
    expect(answer?.by).toMatchObject({ did: martl.identity.author, agent: 'helper' });
    expect((await martl.messages(chat.id)).map((m) => m.text)).toContain('martl is away, I note it for him');

    // Turned off: the node lets them go again.
    await martl.updateAgent({ name: 'helper', permissions: ['weave.msg'], directChats: false });
    sync(martl, box);
    await box.reconcile();
    expect(box.takesDirectChats).toBe(false);
    expect(await box.chats()).toEqual([]);

    // On again, then revoked: the same.
    await martl.updateAgent({ name: 'helper', permissions: ['weave.msg'], directChats: true });
    sync(martl, box);
    await box.reconcile();
    expect(box.takesDirectChats).toBe(true);
    await martl.revokeKey({ key: 'helper' });
    sync(martl, box);
    await box.reconcile();
    expect(box.takesDirectChats).toBe(false);
    expect(await box.chats()).toEqual([]);
    expect((await box.messages(chat.id).catch(() => [])).map((m) => m.text)).not.toContain('just for you');
  });
});
