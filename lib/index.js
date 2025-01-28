'use strict'

var Client = require('./client')
var defaults = require('./defaults')
var Connection = require('./connection')
var Pool = require('pg-pool')
const { DatabaseError } = require('pg-protocol')
const { escapeIdentifier, escapeLiteral } = require('./utils')

module.exports = {
  defaults: defaults,
  Client: Client,
  Query: this.Client.Query,
  Pool: class BoundPool extends Pool {
    constructor(options) {
      super(options, Client)
    }
  },
  _pools: [],
  Connection: Connection,
  types: require('pg-types'),
  DatabaseError: DatabaseError,
  escapeIdentifier: escapeIdentifier,
  escapeLiteral: escapeLiteral
}
