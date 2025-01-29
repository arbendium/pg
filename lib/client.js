// @ts-check

import { EventEmitter } from 'events';
import * as sasl from './crypto/sasl.js';
import * as crypto from './crypto/utils.js';
import Connection from './connection.js';
import Query from './query.js';
import TypeOverrides from './type-overrides.js';

/**
 * @typedef {(
 *   | {
 *     connection?: Connection
 *     stream?: never
 *     keepAlive?: never
 *     keepAliveInitialDelayMillis?: never
 *   }
 *   | {
 *     connection?: never
 *     stream?: import('node:net').Socket
 *     keepAlive?: boolean
 *     keepAliveInitialDelayMillis?: number
 *   }
 * )} ConnectionOptions
 * @typedef {{
 *   applicationName?: string
 *   binary?: boolean
 *   clientEncoding?: string
 *   connectionTimeoutMillis?: number
 *   database?: string
 *   host?: string
 *   idleInTransactionSessionTimeout?: number
 *   lockTimeout?: number
 *   options?: unknown
 *   password?: string | (() => string)
 *   port?: number
 *   queryTimeout?: number
 *   replication?: unknown
 *   ssl?: boolean | Pick<import('node:tls').ConnectionOptions, 'key'>
 *   statementTimeout?: number
 *   user?: string
 * }} ConnectionParametersConfig
 * @typedef {{
 *   application_name: string | undefined
 *   binary: boolean
 *   clientEncoding: string
 *   connect_timeout: number
 *   connectionTimeoutMillis: number
 *   database: string | undefined
 *   host: string
 *   idle_in_transaction_session_timeout: number | false
 *   isDomainSocket: boolean
 *   ssl: boolean | Pick<import('node:tls').ConnectionOptions, 'key'>
 *   lock_timeout: number | false
 *   options: unknown
 *   password: string | (() => string) | undefined
 *   port: number
 *   query_timeout: number | false
 *   replication: unknown
 *   statement_timeout: number | false
 *   user: string | undefined
 * }} ConnectionParameters
 */

/**
 * @param {ConnectionParametersConfig} config
 * @returns {ConnectionParameters}
 */
function normalizeConnectionParameters(config) {
	/** @type {ConnectionParameters} */
	const connectionParameters = {};

	connectionParameters.user = config.user;
	connectionParameters.database = config.database ?? config.user;
	connectionParameters.port = config.port ?? 5432;
	connectionParameters.host = config.host ?? 'localhost';

	// "hiding" the password so it doesn't show up in stack traces
	// or if the client is console.logged
	Object.defineProperty(connectionParameters, 'password', {
		configurable: true,
		enumerable: false,
		writable: true,
		value: config.password
	});

	connectionParameters.binary = config.binary ?? false;
	connectionParameters.options = config.options;
	connectionParameters.ssl = config.ssl ?? false;
	connectionParameters.clientEncoding = config.clientEncoding || 'utf8';
	connectionParameters.replication = config.replication;
	connectionParameters.isDomainSocket = connectionParameters.host != null && connectionParameters.host.startsWith('/');
	connectionParameters.application_name = config.applicationName;
	connectionParameters.statement_timeout = config.statementTimeout ?? false;
	connectionParameters.lock_timeout = config.lockTimeout ?? false;
	connectionParameters.idle_in_transaction_session_timeout = config.idleInTransactionSessionTimeout
		?? false;
	connectionParameters.query_timeout = config.queryTimeout ?? false;
	connectionParameters.connectionTimeoutMillis = config.connectionTimeoutMillis ?? 0;
	connectionParameters.connect_timeout = config.connectionTimeoutMillis != null
		? Math.floor(config.connectionTimeoutMillis / 1000)
		: 0;

	return connectionParameters;
}

export default class Client extends EventEmitter {
	/**
	 * @param {(
	 *   & ConnectionParametersConfig
	 *   & ConnectionOptions
	 *   & { types?: unknown }
	 * )} config
	 */
	constructor(config = {}) {
		super();

		this.connectionParameters = normalizeConnectionParameters(config);

		this._types = new TypeOverrides(config.types);
		this._ending = false;
		this._ended = false;
		this._connecting = false;
		this._connected = false;
		this._connectionError = false;
		this._queryable = true;

		this.connection = 'connection' in config
			? config.connection
			: new Connection({
				stream: config.stream,
				ssl: config.ssl,
				keepAlive: config.keepAlive,
				keepAliveInitialDelayMillis: config.keepAliveInitialDelayMillis
			});
		this.queryQueue = /** @type {Query[]} */([]);
		this.processID = null;
		this.secretKey = null;
	}

	_errorAllQueries(err) {
		const enqueueError = query => {
			process.nextTick(() => {
				query.handleError(err, this.connection);
			});
		};

		if (this.activeQuery) {
			enqueueError(this.activeQuery);
			this.activeQuery = null;
		}

		this.queryQueue.forEach(enqueueError);
		this.queryQueue.length = 0;
	}

	/**
	 * @param {(error: Error | undefined) => void} callback
	 */
	_connect(callback) {
		const self = this;
		const con = this.connection;
		this._connectionCallback = callback;

		if (this._connecting || this._connected) {
			const err = new Error('Client has already been connected. You cannot reuse a client.');
			process.nextTick(() => {
				callback(err);
			});

			return;
		}

		this._connecting = true;

		if (this.connectionParameters.connectionTimeoutMillis > 0) {
			this.connectionTimeoutHandle = setTimeout(
				() => {
					con._ending = true;
					con.stream.destroy(new Error('timeout expired'));
				},
				this.connectionParameters.connectionTimeoutMillis
			);
		}

		if (this.connectionParameters.host && this.connectionParameters.host.indexOf('/') === 0) {
			con.connect(`${this.connectionParameters.host}/.s.PGSQL.${this.connectionParameters.port}`);
		} else {
			con.connect(this.connectionParameters.port, this.connectionParameters.host);
		}

		// once connection is established send startup message
		con.on('connect', () => {
			if (self.connectionParameters.ssl) {
				con.requestSsl();
			} else {
				con.startup(self.getStartupConf());
			}
		});

		con.on('sslconnect', () => {
			con.startup(self.getStartupConf());
		});

		this._attachListeners(con);

		con.once('end', () => {
			const error = this._ending ? new Error('Connection terminated') : new Error('Connection terminated unexpectedly');

			clearTimeout(this.connectionTimeoutHandle);
			this._errorAllQueries(error);
			this._ended = true;

			if (!this._ending) {
				// if the connection is ended without us calling .end()
				// on this client then we have an unexpected disconnection
				// treat this as an error unless we've already emitted an error
				// during connection.
				if (this._connecting && !this._connectionError) {
					if (this._connectionCallback) {
						this._connectionCallback(error);
					} else {
						this._handleErrorEvent(error);
					}
				} else if (!this._connectionError) {
					this._handleErrorEvent(error);
				}
			}

			process.nextTick(() => {
				this.emit('end');
			});
		});
	}

	connect() {
		return new Promise((resolve, reject) => {
			this._connect(error => {
				if (error) {
					reject(error);
				} else {
					resolve(undefined);
				}
			});
		});
	}

	_attachListeners(con) {
		// password request handling
		con.on('authenticationCleartextPassword', this._handleAuthCleartextPassword.bind(this));
		// password request handling
		con.on('authenticationMD5Password', this._handleAuthMD5Password.bind(this));
		// password request handling (SASL)
		con.on('authenticationSASL', this._handleAuthSASL.bind(this));
		con.on('authenticationSASLContinue', this._handleAuthSASLContinue.bind(this));
		con.on('authenticationSASLFinal', this._handleAuthSASLFinal.bind(this));
		con.on('backendKeyData', this._handleBackendKeyData.bind(this));
		con.on('error', this._handleErrorEvent.bind(this));
		con.on('errorMessage', this._handleErrorMessage.bind(this));
		con.on('readyForQuery', this._handleReadyForQuery.bind(this));
		con.on('notice', this._handleNotice.bind(this));
		con.on('rowDescription', this._handleRowDescription.bind(this));
		con.on('dataRow', this._handleDataRow.bind(this));
		con.on('portalSuspended', this._handlePortalSuspended.bind(this));
		con.on('emptyQuery', this._handleEmptyQuery.bind(this));
		con.on('commandComplete', this._handleCommandComplete.bind(this));
		con.on('parseComplete', this._handleParseComplete.bind(this));
		con.on('copyInResponse', this._handleCopyInResponse.bind(this));
		con.on('copyData', this._handleCopyData.bind(this));
		con.on('notification', this._handleNotification.bind(this));
	}

	// TODO(bmc): deprecate pgpass "built in" integration since this.connectionParameters.password can be a function
	// it can be supplied by the user if required - this is a breaking change!
	_checkPgPass(cb) {
		const con = this.connection;

		if (typeof this.connectionParameters.password === 'function') {
			Promise
				.resolve()
				// @ts-ignore
				.then(() => this.connectionParameters.password.call(this))
				.then(/** @param {string | undefined} pass */pass => {
					if (pass != null) {
						if (typeof pass !== 'string') {
							con.emit('error', new TypeError('Password must be a string'));

							return;
						}

						this.connectionParameters.password = pass;
					} else {
						delete this.connectionParameters.password;
					}

					cb();
				})
				.catch(err => {
					con.emit('error', err);
				});
		} else {
			cb();
		}
	}

	// eslint-disable-next-line no-unused-vars
	_handleAuthCleartextPassword(msg) {
		this._checkPgPass(() => {
			this.connection.password(this.connectionParameters.password);
		});
	}

	_handleAuthMD5Password(msg) {
		this._checkPgPass(async () => {
			try {
				const hashedPassword = await crypto.postgresMd5PasswordHash(this.connectionParameters.user, this.connectionParameters.password, msg.salt);
				this.connection.password(hashedPassword);
			} catch (e) {
				this.emit('error', e);
			}
		});
	}

	_handleAuthSASL(msg) {
		this._checkPgPass(() => {
			try {
				this.saslSession = sasl.startSession(msg.mechanisms);
				this.connection.sendSASLInitialResponseMessage(this.saslSession.mechanism, this.saslSession.response);
			} catch (err) {
				this.connection.emit('error', err);
			}
		});
	}

	async _handleAuthSASLContinue(msg) {
		try {
			await sasl.continueSession(this.saslSession, this.connectionParameters.password, msg.data);
			this.connection.sendSCRAMClientFinalMessage(this.saslSession.response);
		} catch (err) {
			this.connection.emit('error', err);
		}
	}

	_handleAuthSASLFinal(msg) {
		try {
			sasl.finalizeSession(this.saslSession, msg.data);
			this.saslSession = null;
		} catch (err) {
			this.connection.emit('error', err);
		}
	}

	_handleBackendKeyData(msg) {
		this.processID = msg.processID;
		this.secretKey = msg.secretKey;
	}

	// eslint-disable-next-line no-unused-vars
	_handleReadyForQuery(msg) {
		if (this._connecting) {
			this._connecting = false;
			this._connected = true;
			clearTimeout(this.connectionTimeoutHandle);

			// process possible callback argument to Client#connect
			if (this._connectionCallback) {
				this._connectionCallback(null, this);
				// remove callback for proper error handling
				// after the connect event
				this._connectionCallback = null;
			}

			this.emit('connect');
		}

		const { activeQuery } = this;
		this.activeQuery = null;
		this.readyForQuery = true;

		if (activeQuery) {
			activeQuery.handleReadyForQuery(this.connection);
		}

		this._pulseQueryQueue();
	}

	// if we receieve an error event or error message
	// during the connection process we handle it here
	_handleErrorWhileConnecting(err) {
		if (this._connectionError) {
			// TODO(bmc): this is swallowing errors - we shouldn't do this
			return;
		}

		this._connectionError = true;
		clearTimeout(this.connectionTimeoutHandle);

		if (this._connectionCallback) {
			return this._connectionCallback(err);
		}

		this.emit('error', err);
	}

	// if we're connected and we receive an error event from the connection
	// this means the socket is dead - do a hard abort of all queries and emit
	// the socket error on the client as well
	_handleErrorEvent(err) {
		if (this._connecting) {
			return this._handleErrorWhileConnecting(err);
		}

		this._queryable = false;
		this._errorAllQueries(err);
		this.emit('error', err);
	}

	// handle error messages from the postgres backend
	_handleErrorMessage(msg) {
		if (this._connecting) {
			return this._handleErrorWhileConnecting(msg);
		}

		const { activeQuery } = this;

		if (!activeQuery) {
			this._handleErrorEvent(msg);

			return;
		}

		this.activeQuery = null;
		activeQuery.handleError(msg, this.connection);
	}

	_handleRowDescription(msg) {
		// delegate rowDescription to active query
		this.activeQuery.handleRowDescription(msg);
	}

	_handleDataRow(msg) {
		// delegate dataRow to active query
		this.activeQuery.handleDataRow(msg);
	}

	// eslint-disable-next-line no-unused-vars
	_handlePortalSuspended(msg) {
		// delegate portalSuspended to active query
		this.activeQuery.handlePortalSuspended(this.connection);
	}

	// eslint-disable-next-line no-unused-vars
	_handleEmptyQuery(msg) {
		// delegate emptyQuery to active query
		this.activeQuery.handleEmptyQuery(this.connection);
	}

	_handleCommandComplete(msg) {
		if (this.activeQuery == null) {
			const error = new Error('Received unexpected commandComplete message from backend.');
			this._handleErrorEvent(error);

			return;
		}

		// delegate commandComplete to active query
		this.activeQuery.handleCommandComplete(msg, this.connection);
	}

	_handleParseComplete() {
		if (this.activeQuery == null) {
			const error = new Error('Received unexpected parseComplete message from backend.');
			this._handleErrorEvent(error);

			return;
		}

		// if a prepared statement has a name and properly parses
		// we track that its already been executed so we don't parse
		// it again on the same client
		if (this.activeQuery.name) {
			this.connection.parsedStatements[this.activeQuery.name] = this.activeQuery.text;
		}
	}

	// eslint-disable-next-line no-unused-vars
	_handleCopyInResponse(msg) {
		this.activeQuery.handleCopyInResponse(this.connection);
	}

	_handleCopyData(msg) {
		this.activeQuery.handleCopyData(msg, this.connection);
	}

	_handleNotification(msg) {
		this.emit('notification', msg);
	}

	_handleNotice(msg) {
		this.emit('notice', msg);
	}

	getStartupConf() {
		const params = this.connectionParameters;

		const data = {
			user: params.user,
			database: params.database
		};

		const appName = params.application_name;

		if (appName) {
			data.application_name = appName;
		}

		if (params.replication) {
			data.replication = `${params.replication}`;
		}

		if (params.statement_timeout) {
			data.statement_timeout = String(parseInt(params.statement_timeout, 10));
		}

		if (params.lock_timeout) {
			data.lock_timeout = String(parseInt(params.lock_timeout, 10));
		}

		if (params.idle_in_transaction_session_timeout) {
			data.idle_in_transaction_session_timeout = String(parseInt(params.idle_in_transaction_session_timeout, 10));
		}

		if (params.options) {
			data.options = params.options;
		}

		return data;
	}

	cancel(client, query) {
		if (client.activeQuery === query) {
			const con = this.connection;

			if (this.connectionParameters.host && this.connectionParameters.host.indexOf('/') === 0) {
				con.connect(`${this.connectionParameters.host}/.s.PGSQL.${this.connectionParameters.port}`);
			} else {
				con.connect(this.connectionParameters.port, this.connectionParameters.host);
			}

			// once connection is established send cancel message
			con.on('connect', () => {
				con.cancel(client.processID, client.secretKey);
			});
		} else if (client.queryQueue.indexOf(query) !== -1) {
			client.queryQueue.splice(client.queryQueue.indexOf(query), 1);
		}
	}

	setTypeParser(oid, format, parseFn) {
		return this._types.setTypeParser(oid, format, parseFn);
	}

	getTypeParser(oid, format) {
		return this._types.getTypeParser(oid, format);
	}

	_pulseQueryQueue() {
		if (this.readyForQuery === true) {
			this.activeQuery = this.queryQueue.shift();

			if (this.activeQuery) {
				this.readyForQuery = false;
				this.hasExecuted = true;

				const queryError = this.activeQuery.submit(this.connection);

				if (queryError) {
					process.nextTick(() => {
						this.activeQuery.handleError(queryError, this.connection);
						this.readyForQuery = true;
						this._pulseQueryQueue();
					});
				}
			} else if (this.hasExecuted) {
				this.activeQuery = null;
				this.emit('drain');
			}
		}
	}

	query(config, values) {
		// can take in strings, config object or query object
		let query;
		let result;
		let readTimeout;
		let readTimeoutTimer;
		let queryCallback;

		if (config === null || config === undefined) {
			throw new TypeError('Client was passed a null or undefined query');
		} else if (typeof config.submit === 'function') {
			readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
			query = config;
			result = config;
		} else {
			readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
			query = new Query(config, values);

			if (!query.callback) {
				result = new Promise((resolve, reject) => {
					query.callback = (err, res) => (err ? reject(err) : resolve(res));
				}).catch(err => {
					// replace the stack trace that leads to `TCP.onStreamRead` with one that leads back to the
					// application that created the query
					Error.captureStackTrace(err);

					throw err;
				});
			}
		}

		if (readTimeout) {
			queryCallback = query.callback;

			readTimeoutTimer = setTimeout(() => {
				const error = new Error('Query read timeout');

				process.nextTick(() => {
					query.handleError(error, this.connection);
				});

				queryCallback(error);

				// we already returned an error,
				// just do nothing if query completes
				query.callback = () => {};

				// Remove from queue
				const index = this.queryQueue.indexOf(query);

				if (index > -1) {
					this.queryQueue.splice(index, 1);
				}

				this._pulseQueryQueue();
			}, readTimeout);

			query.callback = (err, res) => {
				clearTimeout(readTimeoutTimer);
				queryCallback(err, res);
			};
		}

		if (this.connectionParameters.binary && !query.binary) {
			query.binary = true;
		}

		if (query._result && !query._result._types) {
			query._result._types = this._types;
		}

		if (!this._queryable) {
			process.nextTick(() => {
				query.handleError(new Error('Client has encountered a connection error and is not queryable'), this.connection);
			});

			return result;
		}

		if (this._ending) {
			process.nextTick(() => {
				query.handleError(new Error('Client was closed and is not queryable'), this.connection);
			});

			return result;
		}

		this.queryQueue.push(query);
		this._pulseQueryQueue();

		return result;
	}

	ref() {
		this.connection.ref();
	}

	unref() {
		this.connection.unref();
	}

	end() {
		this._ending = true;

		// if we have never connected, then end is a noop, callback immediately
		if (!this.connection._connecting || this._ended) {
			return Promise.resolve();
		}

		if (this.activeQuery || !this._queryable) {
			// if we have an active query we need to force a disconnect
			// on the socket - otherwise a hung query could block end forever
			this.connection.stream.destroy();
		} else {
			this.connection.end();
		}

		return new Promise(resolve => {
			this.connection.once('end', resolve);
		});
	}
}
