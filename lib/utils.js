function escapeElement(elementRepresentation) {
	const escaped = elementRepresentation.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

	return `"${escaped}"`;
}

// convert a JS array to a postgres array literal
// uses comma separator so won't work for types like box that use
// a different array separator.
function arrayString(val) {
	let result = '{';

	for (let i = 0; i < val.length; i++) {
		if (i > 0) {
			result = `${result},`;
		}

		if (val[i] === null || typeof val[i] === 'undefined') {
			result = `${result}NULL`;
		} else if (Array.isArray(val[i])) {
			result += arrayString(val[i]);
		} else if (ArrayBuffer.isView(val[i])) {
			let item = val[i];

			if (!(item instanceof Buffer)) {
				const buf = Buffer.from(item.buffer, item.byteOffset, item.byteLength);

				if (buf.length === item.byteLength) {
					item = buf;
				} else {
					item = buf.slice(item.byteOffset, item.byteOffset + item.byteLength);
				}
			}

			result += `\\\\x${item.toString('hex')}`;
		} else {
			result += escapeElement(prepareValue(val[i]));
		}
	}

	result = `${result}}`;

	return result;
}

// converts values from javascript types
// to their 'raw' counterparts for use as a postgres parameter
// note: you can override this function to provide your own conversion mechanism
// for complex types, etc...
function prepareValue(val, seen) {
	// null and undefined are both null for postgres
	if (val == null) {
		return null;
	}

	if (val instanceof Buffer) {
		return val;
	}

	if (ArrayBuffer.isView(val)) {
		const buf = Buffer.from(val.buffer, val.byteOffset, val.byteLength);

		if (buf.length === val.byteLength) {
			return buf;
		}

		return buf.slice(val.byteOffset, val.byteOffset + val.byteLength); // Node.js v4 does not support those Buffer.from params
	}

	if (val instanceof Date) {
		return val.toISOString();
	}

	if (Array.isArray(val)) {
		return arrayString(val);
	}

	if (typeof val === 'object') {
		return prepareObject(val, seen);
	}

	return val.toString();
}

function prepareObject(val, seen) {
	if (val && typeof val.toPostgres === 'function') {
		seen = seen || [];

		if (seen.indexOf(val) !== -1) {
			throw new Error(`circular reference detected while preparing "${val}" for query`);
		}

		seen.push(val);

		return prepareValue(val.toPostgres(prepareValue), seen);
	}

	return JSON.stringify(val);
}

export function normalizeQueryConfig(config, values, callback) {
	// can take in strings or config objects
	config = typeof config === 'string' ? { text: config } : config;

	if (values) {
		if (typeof values === 'function') {
			config.callback = values;
		} else {
			config.values = values;
		}
	}

	if (callback) {
		config.callback = callback;
	}

	return config;
}

// Ported from PostgreSQL 9.2.4 source code in src/interfaces/libpq/fe-exec.c
export function escapeIdentifier(str) {
	return `"${str.replace(/"/g, '""')}"`;
}

export function escapeLiteral(str) {
	let hasBackslash = false;
	let escaped = '\'';

	for (let i = 0; i < str.length; i++) {
		const c = str[i];

		if (c === '\'') {
			escaped += c + c;
		} else if (c === '\\') {
			escaped += c + c;
			hasBackslash = true;
		} else {
			escaped += c;
		}
	}

	escaped += '\'';

	if (hasBackslash === true) {
		escaped = ` E${escaped}`;
	}

	return escaped;
}

function prepareValueWrapper(value) {
	// this ensures that extra arguments do not get passed into prepareValue
	// by accident, eg: from calling values.map(utils.prepareValue)
	return prepareValue(value);
}

export { prepareValueWrapper as prepareValue };
