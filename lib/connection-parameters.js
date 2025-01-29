const readSSLConfigFromEnvironment = function () {
	switch (process.env.PGSSLMODE) {
	case 'disable':
		return false;
	case 'prefer':
	case 'require':
	case 'verify-ca':
	case 'verify-full':
		return true;
	case 'no-verify':
		return { rejectUnauthorized: false };
	}

	return false;
};

export default class ConnectionParameters {
	constructor(config) {
		// if a string is passed, it is a raw connection string so we parse it into a config
		config ||= {};

		this.user = config.user || (process.platform === 'win32' ? process.env.USERNAME : process.env.USER);
		this.database = config.database || undefined;

		if (this.database === undefined) {
			this.database = this.user;
		}

		this.port = parseInt(config.port || 5432, 10);
		this.host = config.host || 'localhost';

		// "hiding" the password so it doesn't show up in stack traces
		// or if the client is console.logged
		Object.defineProperty(this, 'password', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: config.password || null
		});

		this.binary = config.binary || false;
		this.options = config.options || undefined;

		this.ssl = typeof config.ssl === 'undefined' ? readSSLConfigFromEnvironment() : config.ssl;

		if (typeof this.ssl === 'string') {
			if (this.ssl === 'true') {
				this.ssl = true;
			}
		}

		// support passing in ssl=no-verify via connection string
		if (this.ssl === 'no-verify') {
			this.ssl = { rejectUnauthorized: false };
		}

		if (this.ssl && this.ssl.key) {
			Object.defineProperty(this.ssl, 'key', {
				enumerable: false
			});
		}

		this.client_encoding = config.client_encoding || '';
		this.replication = config.replication || undefined;
		// a domain socket begins with '/'
		this.isDomainSocket = !(this.host || '').indexOf('/');

		this.application_name = config.application_name || undefined;
		this.statement_timeout = config.statement_timeout || false;
		this.lock_timeout = config.lock_timeout || false;
		this.idle_in_transaction_session_timeout = config.idle_in_transaction_session_timeout || false;
		this.query_timeout = config.query_timeout || false;

		if (config.connectionTimeoutMillis === undefined) {
			this.connect_timeout = process.env.PGCONNECT_TIMEOUT || 0;
		} else {
			this.connect_timeout = Math.floor(config.connectionTimeoutMillis / 1000);
		}

		if (config.keepAlive === false) {
			this.keepalives = 0;
		} else if (config.keepAlive === true) {
			this.keepalives = 1;
		}

		if (typeof config.keepAliveInitialDelayMillis === 'number') {
			this.keepalives_idle = Math.floor(config.keepAliveInitialDelayMillis / 1000);
		}
	}
}
