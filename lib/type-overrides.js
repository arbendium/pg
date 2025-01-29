import types from 'pg-types';

export default class TypeOverrides {
	constructor(userTypes) {
		this._types = userTypes || types;
		this.text = {};
		this.binary = {};
	}

	getOverrides(format) {
		switch (format) {
		case 'text':
			return this.text;
		case 'binary':
			return this.binary;
		default:
			return {};
		}
	}

	setTypeParser(oid, format, parseFn) {
		if (typeof format === 'function') {
			parseFn = format;
			format = 'text';
		}

		this.getOverrides(format)[oid] = parseFn;
	}

	getTypeParser(oid, format) {
		format = format || 'text';

		return this.getOverrides(format)[oid] || this._types.getTypeParser(oid, format);
	}
}
