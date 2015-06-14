var parser = exports;

var spdy = require('../../../spdy');
var constants = require('./constants');
var utils = spdy.utils;
var base = spdy.protocol.base;
var util = require('util');
var Buffer = require('buffer').Buffer;

//
// ### function Parser (connection)
// #### @connection {spdy.Connection} connection
// SPDY protocol frames parser's @constructor
//
function Parser(connection) {
  base.Parser.call(this, connection);

  this.paused = false;
  this.buffer = [];
  this.buffered = 0;
  this.waiting = constants.FRAME_HEADER_SIZE;

  this.state = { type: 'frame-head' };
  this.socket = connection.socket;
  this.connection = connection;

  this.version = null;
  this.compress = null;
  this.decompress = null;

  this.connection = connection;
}
util.inherits(Parser, base.Parser);

//
// ### function create (connection)
// #### @connection {spdy.Connection} connection
// @constructor wrapper
//
parser.create = function create(connection) {
  return new Parser(connection);
};

//
// ### function execute (state, data, callback)
// #### @state {Object} Parser's state
// #### @data {Buffer} Incoming data
// #### @callback {Function} continuation callback
// Parse buffered data
//
Parser.prototype.execute = function execute(state, data, callback) {
  if (state.type === 'frame-head') {
    var header = state.header = this.parseHeader(data);

    if (this.version === null && header.control) {
      if (header.version !== 2 && header.version !== 3) {
        return callback(new Error('Unsupported spdy version: ' +
                                  header.version));
      }
      this.setVersion(header.version);
    }

    state.type = 'frame-body';
    callback(null, header.length);
  } else if (state.type === 'frame-body') {
    var self = this;

    // Data frame
    if (!state.header.control) {
      return onFrame(null, {
        type: 'DATA',
        id: state.header.id,
        fin: (state.header.flags & 0x01) === 0x01,
        compressed: (state.header.flags & 0x02) === 0x02,
        data: data
      });
    } else {
      // Control frame
      this.parseBody(state.header, data, onFrame);
    }

    function onFrame(err, frame) {
      if (err) return callback(err);

      self.emit('frame', frame);

      state.type = 'frame-head';
      callback(null, constants.FRAME_HEADER_SIZE);
    };
  }
};


//
// ### function parseHeader (data)
// ### @data {Buffer} incoming data
// Returns parsed SPDY frame header
//
Parser.prototype.parseHeader = function parseHeader(data) {
  var header = {
    control: (data.readUInt8(0) & 0x80) === 0x80 ? true : false,
    version: null,
    type: null,
    id: null,
    flags: data.readUInt8(4),
    length: data.readUInt32BE(4) & 0x00ffffff
  };

  if (header.control) {
    header.version = data.readUInt16BE(0) & 0x7fff;
    header.type = data.readUInt16BE(2);
  } else {
    header.id = data.readUInt32BE(0) & 0x7fffffff;
  }

  return header;
};


//
// ### function execute (header, body, callback)
// #### @header {Object} Frame headers
// #### @body {Buffer} Frame's body
// #### @callback {Function} Continuation callback
// Parse frame (decompress data and create streams)
//
Parser.prototype.parseBody = function parseBody(header, body, callback) {
  // SYN_STREAM or SYN_REPLY
  if (header.type === 0x01 || header.type === 0x02)
    this.parseSynHead(header.type, header.flags, body, callback);
  // RST_STREAM
  else if (header.type === 0x03)
    this.parseRst(body, callback);
  // SETTINGS
  else if (header.type === 0x04)
    this.parseSettings(body, callback);
  else if (header.type === 0x05)
    callback(null, { type: 'NOOP' });
  // PING
  else if (header.type === 0x06)
    this.parsePing(body, callback);
  // GOAWAY
  else if (header.type === 0x07)
    this.parseGoaway(body, callback);
  // HEADERS
  else if (header.type === 0x08)
    this.parseHeaders(body, callback);
  // WINDOW_UPDATE
  else if (header.type === 0x09)
    this.parseWindowUpdate(body, callback);
  // X-FORWARDED
  else if (header.type === 0xf000)
    this.parseXForwarded(body, callback);
  else
    callback(null, { type: 'unknown: ' + header.type, body: body });
};


//
// ### function parseSynHead (type, flags, data)
// #### @type {Number} Frame type
// #### @flags {Number} Frame flags
// #### @data {Buffer} input data
// Returns parsed syn_* frame's head
//
Parser.prototype.parseSynHead = function parseSynHead(type,
                                                      flags,
                                                      data,
                                                      callback) {
  var stream = type === 0x01;
  var offset = stream ? 10 : this.version === 2 ? 6 : 4;

  if (data.length < offset)
    return callback(new Error('SynHead OOB'));

  var kvs = data.slice(offset);
  this.parseKVs(kvs, function(err, headers) {
    if (err)
      return callback(err);

    if (stream === 'SYN_STREAM' &&
        (!headers.method || !(headers.path || headers.url))) {
      return callback(new Error('Missing `:method` and/or `:path` header'));
    }

    callback(null, {
      type: stream ? 'SYN_STREAM' : 'SYN_REPLY',
      id: data.readUInt32BE(0, true) & 0x7fffffff,
      associated: stream ? data.readUInt32BE(4, true) & 0x7fffffff : 0,
      priority: stream ? data[8] >> 5 : 0,
      fin: (flags & 0x01) === 0x01,
      unidir: (flags & 0x02) === 0x02,
      headers: headers,
      url: headers.path || headers.url || ''
    });
  });
};


//
// ### function parseHeaders (data, callback)
// #### @data {Buffer} input data
// #### @callback {Function} continuation
// Parse HEADERS
//
Parser.prototype.parseHeaders = function parseHeaders(data, callback) {
  var offset = this.version === 2 ? 6 : 4;
  if (data.length < offset)
    return callback(new Error('HEADERS OOB'));

  var streamId = data.readUInt32BE(0, true) & 0x7fffffff;

  this.parseKVs(data.slice(offset), function(err, headers) {
    if (err)
      return callback(err);

    callback(null, {
      type: 'HEADERS',
      id: streamId,
      headers: headers
    });
  });
};


//
// ### function parseKVs (pairs, callback)
// #### @pairs {Buffer} header pairs
// #### @callback {Function} continuation
// Returns hashmap of parsed headers
//
Parser.prototype.parseKVs = function parseKVs(pairs, callback) {
  var self = this;
  this.decompress(pairs, function(err, chunks, length) {
    if (err)
      return callback(err);

    var pairs = Buffer.concat(chunks, length);

    var size = self.version === 2 ? 2 : 4;
    if (pairs.length < size)
      return callback(new Error('KV OOB'));

    var count = size === 2 ? pairs.readUInt16BE(0, true) :
                             pairs.readUInt32BE(0, true),
        headers = {};

    pairs = pairs.slice(size);

    function readString() {
      if (pairs.length < size)
        return null;
      var len = size === 2 ? pairs.readUInt16BE(0, true) :
                             pairs.readUInt32BE(0, true);

      if (pairs.length < size + len) {
        return null;
      }
      var value = pairs.slice(size, size + len);

      pairs = pairs.slice(size + len);

      return value.toString();
    }

    while(count > 0) {
      var key = readString(),
          value = readString();

      if (key === null || value === null)
        return callback(new Error('Headers OOB'));

      if (self.version >= 3)
        headers[key.replace(/^:/, '')] = value;
      else
        headers[key] = value;
      count--;
    }

    callback(null, headers);
  });
};


//
// ### function parseRst (data, callback)
// #### @data {Buffer} input data
// #### @callback {Function} continuation
// Parse RST
//
Parser.prototype.parseRst = function parseRst(data, callback) {
  if (data.length < 8)
    return callback(new Error('RST OOB'));

  callback(null, {
    type: 'RST_STREAM',
    id: data.readUInt32BE(0, true) & 0x7fffffff,
    status: data.readUInt32BE(4, true),
    extra: data.length > 8 ? data.slice(8) : null
  });
};


//
// ### function parseSettings (data, callback)
// #### @data {Buffer} input data
// #### @callback {Function} continuation
// Parse SETTINGS
//
Parser.prototype.parseSettings = function parseSettings(data, callback) {
  if (data.length < 4)
    return callback(new Error('SETTINGS OOB'));

  var settings = {},
      number = data.readUInt32BE(0, true),
      idMap = {
        1: 'upload_bandwidth',
        2: 'download_bandwidth',
        3: 'round_trip_time',
        4: 'max_concurrent_streams',
        5: 'current_cwnd',
        6: 'download_retrans_rate',
        7: 'initial_window_size',
        8: 'client_certificate_vector_size'
      };

  if (data.length < 4 + number * 8)
    return callback(new Error('SETTINGS OOB#2'));

  for (var i = 0; i < number; i++) {
    var id = (this.version === 2 ? data.readUInt32LE(4 + i * 8, true) :
                                   data.readUInt32BE(4 + i * 8, true)),
        flags = (id >> 24) & 0xff;
    id = id & 0xffffff;

    var name = idMap[id];

    settings[id] = settings[name] = {
      persist: !!(flags & 0x1),
      persisted: !!(flags & 0x2),
      value: data.readUInt32BE(8 + (i*8), true)
    };
  }

  callback(null, {
    type: 'SETTINGS',
    settings: settings
  });
};


//
// ### function parseGoaway (data, callback)
// #### @data {Buffer} input data
// #### @callback {Function} continuation
// Parse PING
//
Parser.prototype.parsePing = function parsePing(body, callback) {
  if (body.length < 4)
    return callback(new Error('PING OOB'));
  callback(null, { type: 'PING', pingId: body.readUInt32BE(0, true) });
};


//
// ### function parseGoaway (data, callback)
// #### @data {Buffer} input data
// #### @callback {Function} continuation
// Parse GOAWAY
//
Parser.prototype.parseGoaway = function parseGoaway(data, callback) {
  if (data.length < 4)
    return callback(new Error('GOAWAY OOB'));

  callback(null, {
    type: 'GOAWAY',
    lastId: data.readUInt32BE(0, true) & 0x7fffffff
  });
};


//
// ### function parseWindowUpdate (data, callback)
// #### @data {Buffer} input data
// #### @callback {Function} continuation
// Parse WINDOW_UPDATE
//
Parser.prototype.parseWindowUpdate = function parseWindowUpdate(data, callback) {
  if (data.length < 8)
    return callback(new Error('WINDOW_UPDATE OOB'));

  callback(null, {
    type: 'WINDOW_UPDATE',
    id: data.readUInt32BE(0, true) & 0x7fffffff,
    delta: data.readUInt32BE(4, true) & 0x7fffffff
  });
};


//
// ### function parseXForwarded (data, callback)
// #### @data {Buffer} input data
// #### @callback {Function} continuation
// Parse X_FORWARDED
//
Parser.prototype.parseXForwarded = function parseXForwarded(data, callback) {
  if (data.length < 4)
    return callback(new Error('X_FORWARDED OOB'));

  var len = data.readUInt32BE(0, true);
  if (len + 4 > data.length)
    return callback(new Error('X_FORWARDED host length OOB'));

  callback(null, {
    type: 'X_FORWARDED',
    host: data.slice(4, 4 + len).toString()
  });
};