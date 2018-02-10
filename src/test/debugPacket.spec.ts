import './common';
import { assert, spy, stub, SinonSpy } from 'sinon';
import { Bin } from '../interfaces';
import { MessageType } from '../packet/packetHandler';
import { DebugPacketHandler } from '../packet/debugPacketHandler';
import { BufferPacketWriter } from '../packet/bufferPacketWriter';
import { BufferPacketReader } from '../packet/bufferPacketReader';
import { createHandlers } from '../packet/binaryHandler';

describe('DebugPacketHandler', () => {
	let handler: DebugPacketHandler<Buffer>;
	let funcs: any;
	let special: any;
	let binary: any;
	let writer: BufferPacketWriter;
	let reader: BufferPacketReader;
	let log: SinonSpy;

	beforeEach(() => {
		writer = new BufferPacketWriter();
		reader = new BufferPacketReader();
		binary = createHandlers({ foo: [Bin.U8] }, { foo: [Bin.U8] });
		log = spy();
		handler = new DebugPacketHandler<Buffer>(
			['', 'foo', 'abc'], ['', 'bar', 'abc'], writer, reader, binary, {}, ['abc'], log);
	});

	describe('send()', () => {
		it('should log sent message', () => {
			handler.send(spy(), 'foo', 1, ['a', 'b', 5], false);

			assert.calledWithMatch(log, 'SEND [13] (str)', 'foo', [1, 'a', 'b', 5]);
		});

		it('should log sent binary message', () => {
			handler.send(spy(), 'foo', 1, [8], true);

			assert.calledWithMatch(log, 'SEND [2] (bin)', 'foo', [1, 8]);
		});

		it('should not log ignored message', () => {
			handler.send(spy(), 'abc', 2, ['a', 'b', 5], true);

			assert.notCalled(log);
		});
	});

	describe('recv()', () => {
		beforeEach(() => {
			funcs = {
				foo() { },
				abc() { },
			};

			special = {
				'*version'() { },
				'*resolve:bar'() { },
				'*reject:bar'() { },
			};
		});

		it('should log received message', () => {
			handler.recv('[1,"a","b",5]', funcs, special);

			assert.calledWithMatch(log, 'RECV [13] (str)', 'foo', ['a', 'b', 5]);
		});

		it('should log received binary message', () => {
			handler.recv(new Buffer([1, 8]), funcs, special);

			assert.calledWithMatch(log, 'RECV [2] (bin)', 'foo', [8]);
		});

		it('should log invalid message & received message', () => {
			handler.recv('[3,6]', funcs, special);

			assert.calledWithMatch(log, 'RECV [5] (str)', undefined, [6]);
			assert.calledWithMatch(log, 'invalid message: undefined', [6]);
		});

		it('should not log ignored message', () => {
			handler.recv('[2,"a","b",5]', funcs, special);

			assert.notCalled(log);
		});

		it('should read VERSION message from websocket', () => {
			const version = stub(special, '*version');

			handler.recv(JSON.stringify([MessageType.Version, 123]), funcs, special);

			assert.calledWith(version, 123);
		});
	});
});