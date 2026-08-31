import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DiscordRpcClient } from '../src/discord-rpc.ts';
interface RpcPacket {
	opcode: number;
	payload: unknown;
}
class PacketReader {
	private buffer = Buffer.alloc(0);
	private readonly packets: RpcPacket[] = [];
	private readonly waiters: Array<(packet: RpcPacket) => void> = [];
	public constructor(socket: Socket) {
		socket.on('data', (data) => {
			this.buffer = Buffer.concat([this.buffer, data]);
			this.parse();
		});
	}
	public next(): Promise<RpcPacket> {
		const packet = this.packets.shift();
		if (packet) return Promise.resolve(packet);
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}
	private parse(): void {
		while (this.buffer.length >= 8) {
			const payloadLength = this.buffer.readUInt32LE(4);
			if (this.buffer.length < payloadLength + 8) return;
			const packet = {
				opcode: this.buffer.readUInt32LE(0),
				payload: JSON.parse(this.buffer.subarray(8, payloadLength + 8).toString('utf-8')) as unknown
			};
			this.buffer = this.buffer.subarray(payloadLength + 8);
			const waiter = this.waiters.shift();
			if (waiter) waiter(packet);
			else this.packets.push(packet);
		}
	}
}
function encodePacket(opcode: number, payload: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(payload), 'utf-8');
	const packet = Buffer.allocUnsafe(body.length + 8);
	packet.writeUInt32LE(opcode, 0);
	packet.writeUInt32LE(body.length, 4);
	body.copy(packet, 8);
	return packet;
}
function testSocketPaths(t: TestContext): {
	available: string;
	missing: string;
} {
	if (process.platform === 'win32') {
		const suffix = `${process.pid}-${randomUUID()}`;
		return {
			available: `\\\\?\\pipe\\wok-discord-rpc-${suffix}`,
			missing: `\\\\?\\pipe\\wok-discord-rpc-missing-${suffix}`
		};
	}
	const root = mkdtempSync(join(tmpdir(), 'wok-discord-rpc-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return {
		available: join(root, 'available.sock'),
		missing: join(root, 'missing.sock')
	};
}
function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
}
function accept(server: Server): Promise<Socket> {
	return new Promise((resolve) => {
		server.once('connection', resolve);
	});
}
function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
test('connects through fallback paths and exchanges Discord RPC frames', async (t) => {
	const paths = testSocketPaths(t);
	const server = createServer();
	await listen(server, paths.available);
	t.after(async () => {
		if (server.listening) await closeServer(server);
	});
	const accepted = accept(server);
	const client = new DiscordRpcClient('988529967220523068', [paths.missing, paths.available]);
	await client.login();
	const socket = await accepted;
	const reader = new PacketReader(socket);
	assert.deepEqual(await reader.next(), {
		opcode: 0,
		payload: {
			client_id: '988529967220523068',
			v: 1
		}
	});
	const ready = encodePacket(1, { cmd: 'DISPATCH', evt: 'READY' });
	const pingPayload = { nonce: 'server-ping' };
	const ping = encodePacket(3, pingPayload);
	const readyEvent = new Promise<void>((resolve) => {
		client.once('ready', resolve);
	});
	const combined = Buffer.concat([ready, ping]);
	socket.write(combined.subarray(0, 5));
	socket.write(combined.subarray(5));
	await readyEvent;
	assert.deepEqual(await reader.next(), { opcode: 4, payload: pingPayload });
	await client.setActivity({
		details: 'Free for All on Burg',
		state: 'Triggerman',
		timestamps: { start: 1700000000 }
	});
	const activity = await reader.next();
	assert.equal(activity.opcode, 1);
	assert.equal(typeof activity.payload, 'object');
	assert.ok(activity.payload);
	const payload = activity.payload as Record<string, unknown>;
	assert.equal(payload.cmd, 'SET_ACTIVITY');
	assert.equal(typeof payload.nonce, 'string');
	assert.deepEqual(payload.args, {
		activity: {
			details: 'Free for All on Burg',
			state: 'Triggerman',
			timestamps: { start: 1700000000 }
		},
		pid: process.pid
	});
	await client.destroy();
	await closeServer(server);
});
test('rejects invalid client IDs and activity updates before login', async () => {
	assert.throws(() => new DiscordRpcClient('not-a-client-id'), /client ID was invalid/u);
	const client = new DiscordRpcClient('1234', []);
	await assert.rejects(client.setActivity({ details: 'Not connected' }), /not connected/u);
	await assert.rejects(client.login(), /not available/u);
});
