// @ts-check

import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { parse, serialize } from 'pg-protocol';

/**
 * @typedef {{
 *   stream?: undefined | import('node:net').Socket
 *   keepAlive?: undefined | boolean
 *   keepAliveInitialDelayMillis?: undefined | number
 *   ssl?: undefined | boolean | Pick<import('node:tls').ConnectionOptions, 'key'>
 * }} ConnectionConfig
 */

const flushBuffer = serialize.flush();
const syncBuffer = serialize.sync();
const endBuffer = serialize.end();

// TODO(bmc) support binary mode at some point
export default class Connection extends EventEmitter {
	/** @param {ConnectionConfig} config */
	constructor({
		keepAlive = false,
		keepAliveInitialDelayMillis = 0,
		ssl = false,
		stream
	} = {}) {
		super();

		this.stream = stream ?? new net.Socket();

		this.state = {
			connecting: false,
			emitMessage: false,
			ending: false,
			keepAlive,
			keepAliveInitialDelayMillis,
			lastBuffer: false,
			parsedStatements: {},
			ssl
		};

		this.on('newListener', eventName => {
			if (eventName === 'message') {
				this.state.emitMessage = true;
			}
		});
	}

	/**
	 * @overload
	 * @param {string} socket
	 * @param {never} [host]
	 * @returns {void}
	 */
	/**
	 * @overload
	 * @param {number} port
	 * @param {string} host
	 * @returns {void}
	 */
	/**
	 * @param {any} port
	 * @param {any} host
	 */
	connect(port, host) {
		this.state.connecting = true;
		this.stream.setNoDelay(true);

		if (typeof port === 'string') {
			this.stream.connect(port);
		} else {
			this.stream.connect(port, host);
		}

		this.stream.once('connect', () => {
			if (this.state.keepAlive) {
				this.stream.setKeepAlive(true, this.state.keepAliveInitialDelayMillis);
			}

			this.emit('connect');
		});

		const reportStreamError = error => {
			// errors about disconnections should be ignored during disconnect
			if (this.state.ending && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
				return;
			}

			this.emit('error', error);
		};

		this.stream.on('error', reportStreamError);

		this.stream.on('close', () => {
			this.emit('end');
		});

		const { ssl } = this.state;

		if (!ssl) {
			return this.attachListeners(this.stream);
		}

		this.stream.once('data', buffer => {
			const responseCode = buffer.toString('utf8');

			switch (responseCode) {
			case 'S': // Server supports SSL connections, continue with a secure connection
				break;
			case 'N': // Server does not support SSL connections
				this.stream.end();

				return this.emit('error', new Error('The server does not support SSL connections'));
			default:
				// Any other response byte, including 'E' (ErrorResponse) indicating a server error
				this.stream.end();

				return this.emit('error', new Error('There was an error establishing an SSL connection'));
			}

			/** @type {import('node:tls').ConnectionOptions} */
			const options = {
				socket: this.stream,
				...ssl !== true
					? ssl
					: undefined,
				...net.isIP(host) === 0
					? { servername: host }
					: undefined
			};

			try {
				this.stream = tls.connect(options);
			} catch (err) {
				return this.emit('error', err);
			}

			this.attachListeners(this.stream);
			this.stream.on('error', reportStreamError);

			this.emit('sslconnect');
		});
	}

	attachListeners(stream) {
		parse(stream, msg => {
			const eventName = msg.name === 'error' ? 'errorMessage' : msg.name;

			if (this.state.emitMessage) {
				this.emit('message', msg);
			}

			this.emit(eventName, msg);
		});
	}

	requestSsl() {
		this.stream.write(serialize.requestSsl());
	}

	startup(config) {
		this.stream.write(serialize.startup(config));
	}

	cancel(processID, secretKey) {
		this.stream.write(serialize.cancel(processID, secretKey));
	}

	password(password) {
		this.stream.write(serialize.password(password));
	}

	sendSASLInitialResponseMessage(mechanism, initialResponse) {
		this.stream.write(serialize.sendSASLInitialResponseMessage(mechanism, initialResponse));
	}

	sendSCRAMClientFinalMessage(additionalData) {
		this.stream.write(serialize.sendSCRAMClientFinalMessage(additionalData));
	}

	query(text) {
		this.stream.write(serialize.query(text));
	}

	// send parse message
	parse(query) {
		this.stream.write(serialize.parse(query));
	}

	// send bind message
	bind(config) {
		this.stream.write(serialize.bind(config));
	}

	// send execute message
	execute(config) {
		this.stream.write(serialize.execute(config));
	}

	flush() {
		if (this.stream.writable) {
			this.stream.write(flushBuffer);
		}
	}

	sync() {
		this._ending = true;
		this.stream.write(syncBuffer);
	}

	ref() {
		this.stream.ref();
	}

	unref() {
		this.stream.unref();
	}

	end() {
		// 0x58 = 'X'
		this._ending = true;

		if (!this._connecting || !this.stream.writable) {
			this.stream.end();

			return;
		}

		return this.stream.write(endBuffer, () => {
			this.stream.end();
		});
	}

	close(msg) {
		this.stream.write(serialize.close(msg));
	}

	describe(msg) {
		this.stream.write(serialize.describe(msg));
	}

	sendCopyFromChunk(chunk) {
		this.stream.write(serialize.copyData(chunk));
	}

	endCopyFrom() {
		this.stream.write(serialize.copyDone());
	}

	sendCopyFail(msg) {
		this.stream.write(serialize.copyFail(msg));
	}
}
