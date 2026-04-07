import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config, resolveGarminMcpBuild } from '../config.ts';
import type { GarminSessionRecord } from './sessionStore.ts';

type JsonLike = Record<string, unknown> | unknown[] | string | number | boolean | null;

export type GarminSessionAuth = Pick<
  GarminSessionRecord,
  'id' | 'garminEmail' | 'garminPassword' | 'homeDir' | 'tokenDirs'
>;

function isTextContent(
  content: unknown,
): content is { type: 'text'; text: string } {
  return (
    typeof content === 'object' &&
    content !== null &&
    'type' in content &&
    'text' in content &&
    content.type === 'text' &&
    typeof content.text === 'string'
  );
}

function hasContentArray(value: unknown): value is { content: unknown[] } {
  return typeof value === 'object' && value !== null && 'content' in value && Array.isArray(value.content);
}

function extractText(result: unknown): string {
  if (!hasContentArray(result)) {
    throw new Error('The Garmin MCP server returned an incompatible tool payload.');
  }

  const textChunk = result.content.find(isTextContent);
  if (!textChunk) {
    throw new Error('The Garmin MCP server returned a tool response without text content.');
  }

  return textChunk.text;
}

class GarminMcpSessionClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connecting: Promise<void> | null = null;
  private callChain: Promise<unknown> = Promise.resolve();
  private readonly auth: GarminSessionAuth;

  constructor(auth: GarminSessionAuth) {
    this.auth = auth;
  }

  async callJson<T extends JsonLike = JsonLike>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    const nextCall = this.callChain.then(async () => {
      await this.connect();

      try {
        const result = await this.client!.callTool({
          name,
          arguments: args ?? {},
        });

        const text = extractText(result);
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(`Tool ${name} returned non-JSON content: ${text}`);
        }
      } catch (error) {
        await this.close();
        throw error;
      }
    });

    this.callChain = nextCall.catch(() => undefined);
    return nextCall;
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.client = null;
    this.connecting = null;

    if (transport) {
      await transport.close();
    }
  }

  private async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolveGarminMcpBuild('index')],
        env: {
          ...process.env,
          HOME: this.auth.homeDir,
          GARMIN_EMAIL: this.auth.garminEmail,
          GARMIN_PASSWORD: this.auth.garminPassword,
          GARMIN_MCP_TOKEN_DIR: this.auth.tokenDirs.mcp,
        } as Record<string, string>,
        cwd: config.rootDir,
        stderr: 'pipe',
      });

      transport.stderr?.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message) {
          console.info(`[garmin-mcp:${this.auth.id}] ${message}`);
        }
      });

      const client = new Client({
        name: 'garmin-race-dashboard',
        version: '0.1.0',
      });

      await client.connect(transport);

      this.transport = transport;
      this.client = client;
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
}

export class GarminMcpClientManager {
  private clients = new Map<string, GarminMcpSessionClient>();

  async callJson<T extends JsonLike = JsonLike>(
    auth: GarminSessionAuth,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    let client = this.clients.get(auth.id);
    if (!client) {
      client = new GarminMcpSessionClient(auth);
      this.clients.set(auth.id, client);
    }

    return client.callJson<T>(name, args);
  }

  async close(sessionId?: string): Promise<void> {
    if (sessionId) {
      const client = this.clients.get(sessionId);
      this.clients.delete(sessionId);
      if (client) {
        await client.close();
      }
      return;
    }

    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }
}

export const garminMcpClient = new GarminMcpClientManager();
