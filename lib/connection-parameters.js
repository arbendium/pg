import dns from 'node:dns';
import { parse } from 'pg-connection-string'; // parses a connection string

const val = function (key, config, envVar) {
	if (envVar === undefined) {
		envVar = process.env[`PG${key.toUpperCase()}`];
	} else if (envVar === false) {
		// do nothing ... use false
	} else {
		envVar = process.env[envVar];
	}

	return config[key] || envVar;
};

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

// Convert arg to a string, surround in single quotes, and escape single quotes and backslashes
const quoteParamValue = function (value) {
	return `'${(`${value}`).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
};

const add = function (params, config, paramName) {
	const value = config[paramName];

	if (value !== undefined && value !== null) {
		params.push(`${paramName}=${quoteParamValue(value)}`);
	}
};

export default class ConnectionParameters {
	constructor(config) {
		// if a string is passed, it is a raw connection string so we parse it into a config
		config = typeof config === 'string' ? parse(config) : config || {};

		// if the config has a connectionString defined, parse IT into the config we use
		// this will override other default values with what is stored in connectionString
		if (config.connectionString) {
			config = { ...config, ...parse(config.connectionString) };
		}

		this.user = val('user', config) || (process.platform === 'win32' ? process.env.USERNAME : process.env.USER);
		this.database = val('database', config) || undefined;

		if (this.database === undefined) {
			this.database = this.user;
		}

		this.port = parseInt(val('port', config) || 5432, 10);
		this.host = val('host', config) || 'localhost';

		// "hiding" the password so it doesn't show up in stack traces
		// or if the client is console.logged
		Object.defineProperty(this, 'password', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: val('password', config) || null
		});

		this.binary = val('binary', config) || false;
		this.options = val('options', config) || undefined;

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

		this.client_encoding = val('client_encoding', config) || '';
		this.replication = val('replication', config) || undefined;
		// a domain socket begins with '/'
		this.isDomainSocket = !(this.host || '').indexOf('/');

		this.application_name = val('application_name', config, 'PGAPPNAME') || undefined;
		this.fallback_application_name = val('fallback_application_name', config, false) || undefined;
		this.statement_timeout = val('statement_timeout', config, false) || false;
		this.lock_timeout = val('lock_timeout', config, false) || false;
		this.idle_in_transaction_session_timeout = val('idle_in_transaction_session_timeout', config, false) || false;
		this.query_timeout = val('query_timeout', config, false) || false;

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

	getLibpqConnectionString(cb) {
		const params = [];
		add(params, this, 'user');
		add(params, this, 'password');
		add(params, this, 'port');
		add(params, this, 'application_name');
		add(params, this, 'fallback_application_name');
		add(params, this, 'connect_timeout');
		add(params, this, 'options');

		const ssl = typeof this.ssl === 'object' ? this.ssl : this.ssl ? { sslmode: this.ssl } : {};
		add(params, ssl, 'sslmode');
		add(params, ssl, 'sslca');
		add(params, ssl, 'sslkey');
		add(params, ssl, 'sslcert');
		add(params, ssl, 'sslrootcert');

		if (this.database) {
			params.push(`dbname=${quoteParamValue(this.database)}`);
		}

		if (this.replication) {
			params.push(`replication=${quoteParamValue(this.replication)}`);
		}

		if (this.host) {
			params.push(`host=${quoteParamValue(this.host)}`);
		}

		if (this.isDomainSocket) {
			return cb(null, params.join(' '));
		}

		if (this.client_encoding) {
			params.push(`client_encoding=${quoteParamValue(this.client_encoding)}`);
		}

		dns.lookup(this.host, (err, address) => {
			if (err) {
				return cb(err, null);
			}

			params.push(`hostaddr=${quoteParamValue(address)}`);

			return cb(null, params.join(' '));
		});
	}
}
