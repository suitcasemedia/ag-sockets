import './common';
import * as Promise from 'bluebird';
import * as http from 'http';
import * as ws from 'ws';
import { expect } from 'chai';
import { assert, stub, spy, SinonStub, SinonSpy, match } from 'sinon';
import { createServer, ErrorHandler, Method, Socket, Bin, Server as TheServer, SocketServerClient, ServerOptions } from '../index';
import { MockWebSocket, MockWebSocketServer, getLastServer } from './wsMock';

@Socket({ path: '/test', pingInterval: 1000 })
class Server {
	constructor(private client: Client) { }
	@Method({ binary: [Bin.Str], ignore: true })
	hello(message: string) { }
	@Method({ promise: true })
	login(login: string) {
		return login === 'test' ? Promise.resolve(true) : Promise.reject<boolean>(new Error('fail'));
	}
}

class Client {
	@Method({ binary: [Bin.Str], ignore: true })
	hi(message: string) { }
}

class Server2 {
	constructor(private client: Client2) { }
	connected() { }
	disconnected() { }
	hello(message: string) { }
	login(login: string) { return Promise.resolve(true); }
}

class Client2 {
	hi(message: string) { }
}

describe('serverSocket', function () {
	describe('createServer() (real)', function () {
		let server: http.Server;

		beforeEach(function () {
			server = http.createServer();
		});

		afterEach(function (done) {
			server.close(() => done());
		});

		it('should be able to start server (no metadata)', function (done) {
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
				const handleError = spy();
				createServer(server, Server2, Client2, c => new Server2(c), { path: '/test2' });

				assert.calledWith(on, 'connection');
				const [event, callback] = on.getCall(0).args;
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
		let theServer: TheServer;
		let errorHandler: ErrorHandler;
		let onServer: (s: Server2) => void;

		beforeEach(function () {
			errorHandler = {
				handleError(...args: any[]) { console.error('handleError', ...args); },
				handleRecvError(...args: any[]) { console.error('handleRecvError', ...args); },
				handleRejection(...args: any[]) { console.error('handleRejection', ...args); },
			};
			onServer = s => { };
			theServer = createServer(null, Server2, Client2, c => {
				const s = new Server2(c);
				onServer(s);
				return s;
			}, { ws }, errorHandler);
			server = getLastServer();
		});

		it('should connect client', function () {
			const client = server.connectClient();
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

			assert.calledWith(handleError, theServer.clients[0].client, error);
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

			const client = server.connectClient();

			assert.calledWithMatch(handleError, match.any, error);
		});

		it('should handle rejection from server.connected method', function () {
			const error = new Error('test');
			onServer = s => stub(s, 'connected').returns(Promise.reject(error));
			const handleError = stub(errorHandler, 'handleError');

			const client = server.connectClient();

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

		it('close should close the web socket server', function () {
			const close = stub(getLastServer(), 'close');

			theServer.close();

			assert.calledOnce(close);
		});

		it('close call verifyClient on client verification', function () {
			const close = stub(getLastServer(), 'close');

			theServer.close();

			assert.calledOnce(close);
		});
	});

	describe('createServer() (verifyClient hook)', function () {
		const ws = MockWebSocket as any;

		function create(options: ServerOptions) {
			createServer(null, Server2, Client2, c => new Server2(c), options);
			return getLastServer();
		}

		it('should return true by default', function () {
			const server = create({ ws });

			expect(server.options.verifyClient({} as any)).true;
		});

		it('should pass request to custom verifyClient', function () {
			const verifyClient = spy();
			const server = create({ ws, verifyClient });
			const req = {};

			server.options.verifyClient({ req } as any);

			assert.calledWith(verifyClient, req);
		});

		it('should return false if custom verifyClient returns false', function () {
			const verifyClient = stub().returns(false);
			const server = create({ ws, verifyClient });

			expect(server.options.verifyClient({} as any)).false;
		});

		it('should return true if custom verifyClient returns true', function () {
			const verifyClient = stub().returns(true);
			const server = create({ ws, verifyClient });

			expect(server.options.verifyClient({} as any)).true;
		});

		it('should return false if client limit is reached', function () {
			const server = create({ ws, clientLimit: 1 });
			server.connectClient();

			expect(server.options.verifyClient({} as any)).false;
		});
	});
});
