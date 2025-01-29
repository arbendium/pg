import Pool from 'pg-pool';
import Client from './client.js';

export { DatabaseError } from 'pg-protocol';
export { default as types } from 'pg-types';
export { default as Client } from './client.js';
export { default as Connection } from './connection.js';
export { default as Query } from './query.js';
export { escapeIdentifier, escapeLiteral } from './utils.js';
class BoundPool extends Pool {
	constructor(options) {
		super(options, Client);
	}
}

export { BoundPool as Pool };

export const _pools = [];
