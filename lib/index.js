const Pool = require('pg-pool');
const { DatabaseError } = require('pg-protocol');
const Client = require('./client');
const defaults = require('./defaults');
const Connection = require('./connection');
const { escapeIdentifier, escapeLiteral } = require('./utils');

module.exports = {
	defaults,
	Client,
	Query: this.Client.Query,
	Pool: class BoundPool extends Pool {
		constructor(options) {
			super(options, Client);
		}
	},
	_pools: [],
	Connection,
	types: require('pg-types'),
	DatabaseError,
	escapeIdentifier,
	escapeLiteral
};
