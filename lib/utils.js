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
				item = Buffer.from(item.buffer, item.byteOffset, item.byteLength);
			}

			result += `\\\\x${item.toString('hex')}`;
		} else {
			result += escapeElement(prepareValue(val[i]));
		}
	}

	result = `${result}}`;

	return result;
}

export function prepareValue(value) {
	// null and undefined are both null for postgres
	if (value == null) {
		return null;
	}

	if (value instanceof Buffer) {
		return value;
	}

	if (ArrayBuffer.isView(value)) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (Array.isArray(value)) {
		return arrayString(value);
	}

	if (typeof value === 'object') {
		return JSON.stringify(value);
	}

	return value.toString();
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
