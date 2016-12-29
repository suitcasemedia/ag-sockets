import './common';
import * as Promise from 'bluebird';
import * as http from 'http';
import * as ws from 'ws';
import { expect } from 'chai';
import { assert, stub, spy, SinonStub, SinonSpy, match } from 'sinon';
import {
	createServer, ErrorHandler, Method, Socket, Server as TheServer, ServerOptions, broadcast, SocketClient, ClientExtensions, Bin
} from '../index';
import { MessageType } from '../packet/packetHandler';
import { MockWebSocket, MockWebSocketServer, getLastServer } from './wsMock';

@Socket()
class Server2 {
	constructor(public client: Client2 & SocketClient & ClientExtensions) { }
	connected() { }
	disconnected() { }
	@Method()
	hello(_message: string) { }
	@Method({ promise: true })
	login(_login: string) { return Promise.resolve(0); }
}

class Client2 {
	@Method()
	hi(_message: string) { }
	@Method({ binary: [Bin.U8] })
	bye(_value: number) { }
}

function bufferEqual(expectation: number[]) {
	return match.instanceOf(Buffer)
		.and(match((value: Buffer) => value.length === expectation.length))
		.and(match((value: Buffer) => {
			for (let i = 0; i < expectation.length; i++) {
				if (value[i] !== expectation[i])
					return false;
			}

			return true;
		}));
};

describe('serverSocket', function () {
	describe('createServer() (real)', function () {
		let server: http.Server;

		beforeEach(function () {
			server = http.createServer();
		});

		afterEach(function (done) {
			server.close(() => done());
		});

		it('should be able to start server', function (done) {
			createServer(server, Server2, Client2, c => new Server2(c), { path: '/test2' });
			server.listen(12345, done);
		});

		it('should be able to close server', function (done) {
			const socket = createServer(server, Server2, Client2, c => new Server2(c), { path: '/test2' });
			server.listen(12345, () => {
				socket.close();
				done();
			});
		});

		it('should throw if passed object with too many methods', function () {
			const Ctor: any = () => { };

			for (let i = 0; i < 251; i++) {
				Ctor.prototype[`foo${i}`] = () => { };
			}

			expect(() => createServer(server, Ctor, Ctor, () => null)).throw('too many methods');
		});

		describe('(mock WebSocketServer)', function () {
			let wsServer: SinonStub;
			let on: SinonSpy;

			beforeEach(function () {
				wsServer = stub(ws, 'Server');
				wsServer.prototype.on = on = spy();
			});

			afterEach(function () {
				wsServer.restore();
			});

			it('should pass http server to websocket server', function () {
				createServer(server, Server2, Client2, c => new Server2(c), { path: '/test2' });

				assert.calledOnce(wsServer);
				const options = wsServer.getCall(0).args[0];
				expect(options.server).equal(server);
				expect(options.path).equal('/test2');
			});

			it('should pass perMessageDeflate option to websocket server', function () {
				createServer(server, Server2, Client2, c => new Server2(c), { path: '/test2', perMessageDeflate: false });

				assert.calledOnce(wsServer);
				const options = wsServer.getCall(0).args[0];
				expect(options.perMessageDeflate).false;
			});

			it('should setup error handler', function () {
				const handleError = spy();
				createServer(server, Server2, Client2, c => new Server2(c), { path: '/test2' }, { handleError } as any);

				assert.calledWith(on, 'error');
				const [event, callback] = on.getCall(1).args;
				expect(event).equal('error');
				const error = new Error('test');
				callback(error);
				assert.calledWith(handleError, null, error);
			});

			it('should setup work without error handler', function () {
				createServer(server, Server2, Client2, c => new Server2(c), { path: '/test2' });

				assert.calledWith(on, 'error');
				const [event, callback] = on.getCall(1).args;
				expect(event).equal('error');
				callback(new Error('test'));
			});

			it('should setup connetion handler', function () {
				createServer(server, Server2, Client2, c => new Server2(c), { path: '/test2' });

				assert.calledWith(on, 'connection');
				const [event] = on.getCall(0).args;
				expect(event).equal('connection');
			});

			// connecting

			function createTestServer() {
				createServer(server, Server2, Client2, c => new Server2(c), { path: '/test2' });
			}

			function connectTestServer(socket: any) {
				const [event, callback] = on.getCall(0).args;
				expect(event).equal('connection');
				callback(socket);
			}

			function createSocket() {
				return {
					on() { },
					upgradeReq: { url: '/path' }
				};
			}

			it('should attach message handler', function () {
				createTestServer();
				const socket = createSocket();
				const on = stub(socket, 'on');

				connectTestServer(socket);

				assert.calledWith(on, 'message');
			});
		});
	});

	describe('createServer() (mock)', function () {
		const ws = MockWebSocket as any;

		let server: MockWebSocketServer;
		let serverSocket: TheServer;
		let errorHandler: ErrorHandler;
		let servers: Server2[] = [];
		let onServer: (s: Server2) => void;

		beforeEach(function () {
			errorHandler = {
				handleError(...args: any[]) { console.error('handleError', ...args); },
				handleRecvError(...args: any[]) { console.error('handleRecvError', ...args); },
				handleRejection(...args: any[]) { console.error('handleRejection', ...args); },
			};
			servers = [];
			onServer = s => servers.push(s);
			serverSocket = createServer({} as any, Server2, Client2, client => {
				const s = new Server2(client);
				onServer(s);
				return s;
			}, { ws }, errorHandler);
			server = getLastServer();
		});

		it('should connect client', function () {
			server.connectClient();
		});

		it('should handle socket server error', function () {
			const error = new Error('test');
			const handleError = stub(errorHandler, 'handleError');

			server.invoke('error', error);

			assert.calledWith(handleError, null, error);
		});

		it('should handle socket error', function () {
			const client = server.connectClient();
			const error = new Error('test');
			const handleError = stub(errorHandler, 'handleError');

			client.invoke('error', error);

			assert.calledWith(handleError, serverSocket.clients[0].client, error);
		});

		it('should terminate and handle error on connection error', function () {
			const client = new MockWebSocket();
			const error = new Error('test');
			stub(client, 'on').throws(error);
			const terminate = stub(client, 'terminate');
			const handleError = stub(errorHandler, 'handleError');

			server.invoke('connection', client);

			assert.calledOnce(terminate);
			assert.calledWith(handleError, null, error);
		});

		it('should handle exception from server.connected method', function () {
			const error = new Error('test');
			onServer = s => stub(s, 'connected').throws(error);
			const handleError = stub(errorHandler, 'handleError');

			server.connectClient();

			assert.calledWithMatch(handleError, match.any, error);
		});

		it('should handle rejection from server.connected method', function () {
			const error = new Error('test');
			onServer = s => stub(s, 'connected').returns(Promise.reject(error));
			const handleError = stub(errorHandler, 'handleError');

			server.connectClient();

			return Promise.resolve()
				.then(() => assert.calledWithMatch(handleError, match.any, error));
		});

		it('should handle exception from server.disconnected method', function () {
			const error = new Error('test');
			onServer = s => stub(s, 'disconnected').throws(error);
			const handleError = stub(errorHandler, 'handleError');
			const client = server.connectClient();

			client.invoke('close');

			assert.calledWithMatch(handleError, match.any, error);
		});

		it('should handle rejection from server.disconnected method', function () {
			const error = new Error('test');
			onServer = s => stub(s, 'disconnected').returns(Promise.reject(error));
			const handleError = stub(errorHandler, 'handleError');
			const client = server.connectClient();

			client.invoke('close');

			return Promise.resolve()
				.then(() => assert.calledWithMatch(handleError, match.any, error));
		});

		it('should be able to handle message from client', function () {
			const client = server.connectClient();
			const hello = stub(servers[0]!, 'hello');

			client.invoke('message', '[0, "test"]');

			assert.calledWith(hello, 'test');
		});

		it('should be able to send promise result back to client', function () {
			const client = server.connectClient();
			const send = stub(client, 'send');
			stub(servers[0], 'login').returns(Promise.resolve({ foo: 'bar' }));

			client.invoke('message', '[1, "test"]');

			return Promise.delay(1)
				.then(() => assert.calledWith(send, JSON.stringify([MessageType.Resolved, 1, 1, { foo: 'bar' }])));
		});

		it('should be able to send message to client (JSON)', function () {
			const client = server.connectClient();
			const send = stub(client, 'send');

			servers[0].client.hi('boop');

			assert.calledWith(send, '[0,"boop"]');
		});

		it('should be able to send message to client (binary)', function () {
			const client = server.connectClient(true);
			const send = stub(client, 'send');

			servers[0].client.bye(5);

			assert.calledWith(send, bufferEqual([1, 5]));
		});

		describe('.close()', function () {
			it('should close the web socket server', function () {
				const close = stub(getLastServer(), 'close');

				serverSocket.close();

				assert.calledOnce(close);
			});
		});

		describe('broadcast()', function () {
			it('should send message to all clients (JSON)', function () {
				const send1 = stub(server.connectClient(), 'send');
				const send2 = stub(server.connectClient(), 'send');
				const clients = servers.map(s => s.client);

				broadcast(clients, c => c.hi('boop'));

				assert.calledWith(send1, '[0,"boop"]');
				assert.calledWith(send2, '[0,"boop"]');
			});

			it('should send message to all clients (binary)', function () {
				const send1 = stub(server.connectClient(true), 'send');
				const send2 = stub(server.connectClient(true), 'send');
				const clients = servers.map(s => s.client);

				broadcast(clients, c => c.bye(5));

				assert.calledWith(send1, bufferEqual([1, 5]));
				assert.calledWith(send2, bufferEqual([1, 5]));
			});

			it('should send message to all clients (mixed)', function () {
				const send1 = stub(server.connectClient(true), 'send');
				const send2 = stub(server.connectClient(), 'send');
				const clients = servers.map(s => s.client);

				broadcast(clients, c => c.bye(5));

				assert.calledWith(send1, bufferEqual([1, 5]));
				assert.calledWith(send2, '[1,5]');
			});

			it('should do nothing for empty client list', function () {
				broadcast([] as Client2[], c => c.hi('boop'));
			});

			it('should throw for invalid client object', function () {
				expect(() => broadcast([{}] as any[], c => c.hi('boop'))).throw('Invalid client');
			});

			it('should call callback only once', function () {
				server.connectClients(3);
				const clients = servers.map(s => s.client);
				const action = spy();

				broadcast(clients, action);

				assert.calledOnce(action);
			});
		});
	});

	describe('createServer() (verifyClient hook)', function () {
		const ws = MockWebSocket as any;

		function create(options: ServerOptions, errorHandler?: ErrorHandler) {
			createServer({} as any, Server2, Client2, c => new Server2(c), options, errorHandler);
			return getLastServer();
		}

		function verify(server: MockWebSocketServer, info: any = {}) {
			return new Promise<boolean>(resolve => server.options.verifyClient!(info, resolve));
		}

		it('should return true by default', function () {
			const server = create({ ws });

			return expect(verify(server)).eventually.true;
		});

		it('should pass request to custom verifyClient', function () {
			const verifyClient = spy();
			const server = create({ ws, verifyClient });
			const req = {};

			return verify(server, { req })
				.then(() => assert.calledWith(verifyClient, req));
		});

		it('should return false if custom verifyClient returns false', function () {
			const verifyClient = stub().returns(false);
			const server = create({ ws, verifyClient });

			return expect(verify(server)).eventually.false;
		});

		it('should return true if custom verifyClient returns true', function () {
			const verifyClient = stub().returns(true);
			const server = create({ ws, verifyClient });

			return expect(verify(server)).eventually.true;
		});

		it('should return false if client limit is reached', function () {
			const server = create({ ws, clientLimit: 1 });
			server.connectClient();

			return expect(verify(server)).eventually.false;
		});

		it('should return false if custom verifyClient returns a promise resolving to false', function () {
			const verifyClient = stub().returns(Promise.resolve(false));
			const server = create({ ws, verifyClient });

			return expect(verify(server)).eventually.false;
		});

		it('should return true if custom verifyClient returns a promise resolving to true', function () {
			const verifyClient = stub().returns(Promise.resolve(true));
			const server = create({ ws, verifyClient });

			return expect(verify(server)).eventually.true;
		});

		it('should return false if custom verifyClient throws an error', function () {
			const verifyClient = stub().throws(new Error('test'));
			const server = create({ ws, verifyClient });

			return expect(verify(server)).eventually.false;
		});

		it('should return false if custom verifyClient returns a rejected promise', function () {
			const verifyClient = stub().returns(Promise.reject(new Error('test')));
			const server = create({ ws, verifyClient });

			return expect(verify(server)).eventually.false;
		});

		it('should report error if custom verifyClient throws an error', function () {
			const error = new Error('test');
			const errorHandler: any = { handleError() { } };
			const handleError = stub(errorHandler, 'handleError');
			const verifyClient = stub().throws(error);
			const server = create({ ws, verifyClient }, errorHandler);

			return verify(server)
				.then(() => assert.calledWith(handleError, null, error));
		});

		it('should report error if custom verifyClient returns a rejected promise', function () {
			const error = new Error('test');
			const errorHandler: any = { handleError() { } };
			const handleError = stub(errorHandler, 'handleError');
			const verifyClient = stub().returns(Promise.reject(error));
			const server = create({ ws, verifyClient }, errorHandler);

			return verify(server)
				.then(() => assert.calledWith(handleError, null, error));
		});
	});
});
