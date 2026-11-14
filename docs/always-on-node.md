# Your always-on node

A server, a NAS or a home cluster that keeps your spaces and hosts your rooms while your computers are off. Friends play your app at three in the morning, and what they write in your groups and projects reaches you when you're back.

## What it may do

- **Its key:** It gets a key of its own, issued by one of your computers like an agent's. That key may host your rooms (`weave.room…`) and nothing else. Anything else it signed, everyone else would drop, so it doesn't even try: it can't post, chat, vote, invite or change anything for you.
- **What it reads:** It holds your encryption keys and the keys of your groups, projects and communities, so it can keep them (it runs as an archive and keeps everything) and check who may join your rooms.
- **What it doesn't get:** your direct chats, unless an agent on it is to read them (see [An agent on your always-on node](#an-agent-on-your-always-on-node)). It can't add devices, rotate keys or recover anything: that still takes your recovery words.
- **Revoking:** Revoke it like an agent, in Weave (Keys & devices → Always-on nodes → Revoke) or with `weave revoke node:<name>`. What it signs from then on counts nowhere.
- **No recovery words:** Pairing never asks for them.

## Pairing

1. **On the node:** run `weave-server pair kitchen-nas` (or `weave node pair kitchen-nas`). It shows a request: `weave:node-request:…`.
2. **On one of your computers:** in Weave, open Keys & devices → Always-on nodes, paste the request and click **Link node**. From the command line it's `weave node add <request>`. You get an answer: `weave:node-answer:…`, boxed so that only that node can open it.
3. **On the node:** run `weave-server join <answer>`, then `weave-server run`.

Spaces you join later reach it too: while you have an always-on node, your computers keep a sealed list of your spaces for it in your own space.

## An agent on your always-on node

One of your agents can live on the node: it reads and answers while your computers are off. It signs with a key of its
own and shows as "you · its name", like any of your agents. It never signs as you: the node's own key still signs
rooms only, and your identity and recovery words stay on your computers.

- **What it can do:** exactly the kinds you give it, as for any agent (`--can`). It posts, replies and chats in your
  groups, projects and communities, which the node keeps and reads anyway.
- **What it reads:** what the node reads. Its inbox (`weave_inbox` over MCP) and `watch` show what arrives in your
  groups, projects and communities.
- **Direct chats:** not on the node, unless you say so for that agent (`--direct-chats`, or the checkbox in the app).
  Then the node takes your direct chats too (it derives their keys from your encryption keys, which it already
  holds), and that agent reads them and answers there under its own key ("you · its name"). Other agents on the node
  see them arrive too, but can't write there. Turn it off, or revoke the agent, and the node lets your direct chats go
  again. While it's on, the keys to your direct chats are on the node too: keep the node as private as a computer of
  yours.
- **Its key:** made on your computer, sealed so that only that node opens it, and kept nowhere else. Your computer
  never stores it.
- **Changing and revoking:** like any agent. `weave agent can <name> <kinds>` changes its rights (add
  `--direct-chats` or `--no-direct-chats`); `weave revoke <name>` revokes it: what it signs from then on counts
  nowhere, and the node drops its key. In the app: Keys & devices → Always-on nodes, under the node.

**On your computer:** add it for the node by its name (the one in Keys & devices, or `node:<name>` in `weave keys`):

```bash
weave agent add claude --node kitchen-nas --can weave.post,weave.reply,weave.msg
weave agent add helper --node kitchen-nas --can weave.msg --direct-chats   # also your direct chats
weave agent list                                                            # "on kitchen-nas"
```

In the app: Keys & devices → Always-on nodes → **Add an agent here…** under the node: a name, what it may do, and
whether it reads your direct chats.

**On the node:** it takes the agent within a moment of hearing from your computer. Then a harness on the node talks
to the running node as that agent:

```bash
weave-server mcp --as claude        # MCP over stdio, for the harness's config
weave-server watch                  # what arrives, as JSON lines
```

With the `weave` command line on the node instead, it's `weave mcp --as claude` and `weave watch --as claude`.

With Docker, run the harness in the container (or in one that shares its volume and network):

```bash
docker exec -i weave node /app/weave-server.mjs mcp --as claude
```

In Kubernetes, the harness runs as another container in the pod and talks to the node over `127.0.0.1`, or from
outside with:

```bash
kubectl exec -i deploy/weave -c weave -- node /app/weave-server.mjs mcp --as claude
```

## Your front door

An always-on node is your front door: besides your own meeting point it's found at a public one, which only front
doors announce and let people in through. Your computers never do.

- `weave contact --door` (on any of your computers) prints a contact link through the front door. Give that one to
  anyone: a website, a post, an app's bundle. Whoever adds it reaches your always-on node, never your computer.
- Through it, a newcomer gets your public side (your name, your public posts and project pages) and nothing about
  the people you know. That holds for every peer: a node shares only its person's public side and that of the people
  the peer shares a space or a chat with there.
- Your personal contact link stays as it was: for people you want to reach your computer.
- A node's config can say otherwise: `"frontDoor": false` closes the door on an always-on node; `"frontDoor": true`
  makes any node one.

## With Docker

```bash
docker run -it --rm -v weave:/data ghcr.io/martl-projects/weave-server pair kitchen-nas
docker run -it --rm -v weave:/data ghcr.io/martl-projects/weave-server join 'weave:node-answer:…'
docker run -d --name weave --restart unless-stopped -v weave:/data ghcr.io/martl-projects/weave-server
```

- **Ports:** It needs no open ports: Weave finds its peers through the network's DHT and connects outward, and connections through firewalls work too (hole punching).
- **Health:** The image's health check asks `weave-server status`.
- **Keys:** In a container there's no keystore of the operating system. The home key lies in the volume (`vault.json`), so keep the volume as private as the machine.

## In a Kubernetes cluster

- **Pods:** One pod, one replica, `Recreate`. Two copies of the same node would sign as the same key at once, which Weave reports as a stolen key.
- **The app beside it:** A room's app runs as a second container in the same pod: they share `127.0.0.1`, and the room forwards to the app's port there. With `start.image`, that's the image the project released, at the digest in its release.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: weave }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: weave } }
  template:
    metadata: { labels: { app: weave } }
    spec:
      containers:
        - name: weave
          image: ghcr.io/martl-projects/weave-server:0.17.2
          volumeMounts: [{ name: data, mountPath: /data }]
          livenessProbe: { exec: { command: [node, /app/weave-server.mjs, status] }, periodSeconds: 60 }
        - name: party-app            # a room's app, beside the node
          image: ghcr.io/you/party-game@sha256:…
          env: [{ name: PORT, value: "3000" }]
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: weave-data }
```

Pair it once with `kubectl exec -it deploy/weave -c weave -- node /app/weave-server.mjs pair cluster`, then `… join <answer>`, then restart the pod.

## Tried, and not yet

- **Tested:**
  - **Pairing:** the request, the answer and joining.
  - **Spaces:** the node reads your spaces, and a space created later reaches it.
  - **Refusing:** It refuses to post, and others would drop it anyway.
  - **Hosting:** It hosts a room while your computer is offline, and a friend reaches the app through it (local test network).
  - **Revoking:** Revocation reaches the others.
  - **An agent on the node:** handed over sealed, it posts and chats as "you · its name" within its rights; the key is in no file on the computer; revoking it voids what it signs after and the node drops its key. Direct chats stay off the node unless that agent is to read them; then it reads and answers them.
- **Tried on this computer:** the built Weave Server: `pair`, `join` (with the answer from the app's new Always-on nodes section and from the command line), `run`, `status`, and a clean `weave daemon stop`.
- **Not tried:** the Docker image and Kubernetes (Docker didn't start here), and a node on another network for days.
