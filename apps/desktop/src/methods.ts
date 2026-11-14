import { RPC_METHODS, type RpcMethod } from '@weave/node/client';

/** Backend methods the renderer may call: everything but creating agent keys or tokens and listening on raw topics. */
export const RENDERER_METHODS: readonly RpcMethod[] = RPC_METHODS.filter((m) => m !== 'addAgent' && m !== 'agentToken' && m !== 'join');

export type RendererMethod = RpcMethod;
