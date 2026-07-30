import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';

const RPC_PROTOCOL_VERSION = 1;
const RPC_HEADER_BYTES = 8;
const MAX_RPC_PAYLOAD_BYTES = 1024 * 1024;
const SOCKET_CONNECT_TIMEOUT_MS = 750;
const SOCKET_CLOSE_TIMEOUT_MS = 250;

const RpcOpcode = {
	Handshake: 0,
	Frame: 1,
	Close: 2,
	Ping: 3,
	Pong: 4
} as const;

type RpcOpcode = (typeof RpcOpcode)[keyof typeof RpcOpcode];

interface DiscordRpcActivity {
	assets?: {
		large_image?: string;
		large_text?: string;
		small_image?: string;
		small_text?: string;
	};
	buttons?: Array<{ label: string; url: string }>;
	details?: string;
	state?: string;
	timestamps?: { end?: number; start?: number };
	type?: 0 | 2 | 3 | 5;
}

interface DiscordRpcPayload {
	cmd?: string;
	evt?: string;
}

function encodePacket(opcode: RpcOpcode, payload: unknown): Buffer {
	const serialized = JSON.stringify(payload);
	if (serialized === undefined) throw new Error('Discord RPC payload was not JSON serializable.');

	const body = Buffer.from(serialized, 'utf-8');
	if (body.length > MAX_RPC_PAYLOAD_BYTES) throw new Error('Discord RPC payload exceeded the size limit.');

	const frame = Buffer.allocUnsafe(RPC_HEADER_BYTES + body.length);
	frame.writeUInt32LE(opcode, 0);
	frame.writeUInt32LE(body.length, 4);
	body.copy(frame, RPC_HEADER_BYTES);
	return frame;
}

function isPayloadRecord(value: unknown): value is DiscordRpcPayload {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultSocketPaths(): string[] {
	if (process.platform === 'win32') {
		return Array.from({ length: 10 }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`);
	}

	const baseDirectories = [
		process.env.XDG_RUNTIME_DIR,
		process.env.TMPDIR,
		process.env.TMP,
		process.env.TEMP,
		'/tmp'
	].filter((value): value is string => Boolean(value));
	const paths: string[] = [];

	for (const baseDirectory of new Set(baseDirectories)) {
		if (!existsSync(baseDirectory)) continue;
		for (let index = 0; index < 10; index += 1) {
			paths.push(join(baseDirectory, `discord-ipc-${index}`));
			if (process.platform !== 'linux') continue;
			paths.push(join(baseDirectory, 'snap.discord', `discord-ipc-${index}`));
			paths.push(join(baseDirectory, 'app', 'com.discordapp.Discord', `discord-ipc-${index}`));
		}
	}

	return paths;
}

function connectToSocket(socketPath: string): Promise<Socket | undefined> {
	return new Promise(resolve => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = (connectedSocket?: Socket) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.removeListener('connect', onConnect);
			socket.removeListener('error', onError);
			if (!connectedSocket) socket.destroy();
			resolve(connectedSocket);
		};
		const onConnect = () => finish(socket);
		const onError = () => finish();
		const timeout = setTimeout(() => finish(), SOCKET_CONNECT_TIMEOUT_MS);
		timeout.unref();
		socket.once('connect', onConnect);
		socket.once('error', onError);
	});
}

export class DiscordRpcClient extends EventEmitter {
	private receiveBuffer = Buffer.alloc(0);
	private readonly clientId: string;
	private readonly socketPaths: readonly string[];
	private socket?: Socket;
	private loginAttempt?: Promise<void>;
	private lifecycle = 0;

	public constructor(clientId: string, socketPaths: readonly string[] = defaultSocketPaths()) {
		super();
		if (!/^\d{1,32}$/u.test(clientId)) throw new Error('Discord RPC client ID was invalid.');
		this.clientId = clientId;
		this.socketPaths = [...socketPaths];
	}

	public async login(): Promise<void> {
		if (this.isConnected()) return;
		if (this.loginAttempt) return this.loginAttempt;

		const lifecycle = this.lifecycle;
		const attempt = this.connectAndHandshake(lifecycle);
		this.loginAttempt = attempt;
		try {
			await attempt;
		} finally {
			if (this.loginAttempt === attempt) this.loginAttempt = undefined;
		}
	}

	public async setActivity(activity: DiscordRpcActivity): Promise<void> {
		this.sendRequest('SET_ACTIVITY', {
			activity,
			pid: process.pid
		});
	}

	public async destroy(): Promise<void> {
		this.lifecycle += 1;
		const socket = this.socket;
		this.detachSocket(socket);
		if (!socket || socket.destroyed) return;

		await new Promise<void>(resolve => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve();
			};
			const timeout = setTimeout(() => {
				socket.destroy();
				finish();
			}, SOCKET_CLOSE_TIMEOUT_MS);
			timeout.unref();
			socket.once('close', finish);
			socket.end();
		});
	}

	private async connectAndHandshake(lifecycle: number): Promise<void> {
		for (const socketPath of this.socketPaths) {
			const socket = await connectToSocket(socketPath);
			if (!socket) continue;
			if (lifecycle !== this.lifecycle) {
				socket.destroy();
				throw new Error('Discord RPC connection was cancelled.');
			}

			this.attachSocket(socket);
			this.send(RpcOpcode.Handshake, {
				client_id: this.clientId,
				v: RPC_PROTOCOL_VERSION
			});
			return;
		}

		throw new Error('Discord desktop RPC socket was not available.');
	}

	private attachSocket(socket: Socket): void {
		const previousSocket = this.socket;
		if (previousSocket && previousSocket !== socket) previousSocket.destroy();
		this.socket = socket;
		this.receiveBuffer = Buffer.alloc(0);
		socket.setNoDelay(true);
		socket.on('data', data => { this.consume(socket, data); });
		socket.on('close', () => { this.detachSocket(socket); });
		socket.on('error', () => {
			this.detachSocket(socket);
			socket.destroy();
		});
	}

	private detachSocket(socket?: Socket): void {
		if (!socket || this.socket !== socket) return;
		this.socket = undefined;
		this.receiveBuffer = Buffer.alloc(0);
	}

	private consume(socket: Socket, data: Buffer): void {
		if (this.socket !== socket) return;
		this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

		while (this.receiveBuffer.length >= RPC_HEADER_BYTES) {
			const opcode = this.receiveBuffer.readUInt32LE(0);
			const payloadLength = this.receiveBuffer.readUInt32LE(4);
			if (payloadLength > MAX_RPC_PAYLOAD_BYTES) {
				socket.destroy(new Error('Discord RPC response exceeded the size limit.'));
				return;
			}

			const packetLength = RPC_HEADER_BYTES + payloadLength;
			if (this.receiveBuffer.length < packetLength) return;

			const body = this.receiveBuffer.subarray(RPC_HEADER_BYTES, packetLength);
			this.receiveBuffer = this.receiveBuffer.subarray(packetLength);
			let payload: unknown;
			try {
				payload = JSON.parse(body.toString('utf-8'));
			} catch (_error) {
				continue;
			}

			if (opcode === RpcOpcode.Ping) {
				this.send(RpcOpcode.Pong, payload);
				continue;
			}
			if (opcode === RpcOpcode.Close) {
				socket.end();
				continue;
			}
			if (
				opcode === RpcOpcode.Frame
				&& isPayloadRecord(payload)
				&& payload.cmd === 'DISPATCH'
				&& payload.evt === 'READY'
			) {
				this.emit('ready');
			}
		}
	}

	private sendRequest(command: string, args: Record<string, unknown>): void {
		this.send(RpcOpcode.Frame, {
			args,
			cmd: command,
			nonce: randomUUID()
		});
	}

	private send(opcode: RpcOpcode, payload: unknown): void {
		const socket = this.socket;
		if (!socket || socket.destroyed || !socket.writable) {
			throw new Error('Discord RPC client is not connected.');
		}
		socket.write(encodePacket(opcode, payload));
	}

	private isConnected(): boolean {
		return Boolean(this.socket && !this.socket.destroyed && this.socket.writable);
	}
}
