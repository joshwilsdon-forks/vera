/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var dbHelpers = require('./db_helpers');
var deepcopy = require('deepcopy');
var error = require('../error');
var events = require('events');
var lib = require('../leveldb');
var leveldbkey = require('./key');
var memstream = require('../memstream');
var PairsStream = require('../pairs_stream');
var Readable = require('stream').Readable;
var sprintf = require('extsprintf').sprintf;
var stream = require('stream');
var util = require('util');



/**
 * LevelDB (https://code.google.com/p/leveldb/) used as the backing persistance
 * layer for the raft log.
 */

///--- Globals

var propertyKey = leveldbkey.internalProperty;
var logKey = leveldbkey.log;
var errToObj = lib.errToObj;
var SYNC_OPTIONS = { 'sync': true };
var LAST_INDEX_KEY = propertyKey('lastLogIndex');
var CLUSTER_CONFIG_KEY = propertyKey('clusterConfigIndex');



///--- Functions

function LevelDbLog(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.location, 'opts.location');
    assert.optionalObject(opts.db, 'opts.db');
    assert.object(opts.stateMachine, 'opts.stateMachine');
    assert.optionalObject(opts.clusterConfig, 'opts.clusterConfig');

    var self = this;
    self.log = opts.log;
    self.stateMachine = opts.stateMachine;
    self.open = false;
    openDb.call(self, opts);
}

util.inherits(LevelDbLog, events.EventEmitter);
module.exports = LevelDbLog;


///--- Helpers

/**
 * Does the actual initing of the leveldb log.  It will emit either ready or
 * error exactly once.
 */
function openDb(opts) {
    var self = this;
    var log = self.log;
    var lastIndex;
    var clusterConfigIndex;

    function setupSelf() {
        log.debug({ 'index': lastIndex }, 'reading last entry');
        opts.db.get(logKey(lastIndex), function (err, lastEntry) {
            if (err || !lastEntry) {
                log.fatal({ 'error': errToObj(err), 'last': lastEntry },
                          'Error fetching last entry in log');
                return (self.emit('error', err));
            }
            opts.db.get(logKey(clusterConfigIndex), function (err2, config) {
                if (err2 || !config) {
                    log.fatal({ 'error': errToObj(err2), 'config': config },
                              'Error fetching cluster config in log');
                    return (self.emit('error', err));
                }
                self.nextIndex = lastEntry.index + 1;
                self.lastEntry = lastEntry;
                self.clusterConfigIndex = clusterConfigIndex;
                self.clusterConfig = config.command.cluster;
                //I'm not sure how much I like setting this property like this.
                self.clusterConfig.clogIndex = self.clusterConfigIndex;
                self.db = opts.db;
                self.open = true;
                return (self.emit('ready'));
            });
        });
    }

    function initDb() {
        //If no clusterConfig is passed, we write *nothing* to the log,
        // knowing that at some point a snapshot needs to come along and
        // rebootstrap us *or* the process is restarted with a config.
        if (!opts.clusterConfig) {
            log.info('No cluster configuration present. Leveldb is open, ' +
                     'but no progress will be made until bootstrapped with a ' +
                     'snapshot or a valid configuration is given.');
            self.db = opts.db;
            self.open = true;
            return (self.emit('ready'));
        }

        //The Raft paper says that the index should start at one.  Rather
        // than doing that, a fixed [0] ensures that the consistency check
        // will always succeed without special logic for the first entry.
        var firstLogEntry = {
            'term': 0,
            'index': 0,
            'command': {
                'to': 'raft',
                'execute': 'configure',
                'cluster': opts.clusterConfig
            }
        };
        opts.db.batch([
            { 'type': 'put',
              'key': logKey(0),
              'value': firstLogEntry
            },
            { 'type': 'put',
              'key': LAST_INDEX_KEY,
              'value': 0
            },
            { 'type': 'put',
              'key': CLUSTER_CONFIG_KEY,
              'value': 0
            }
        ], SYNC_OPTIONS, function (err) {
            if (err) {
                log.fatal({ 'error': errToObj(err) },
                          'Error writing first log entry');
                return (self.emit('error', err));
            }
            lastIndex = 0;
            clusterConfigIndex = 0;
            setupSelf();
        });
    }

    function findLastIndexAndClusterIndex() {
        opts.db.get(LAST_INDEX_KEY, function (err, lastIndexVal) {
            if (err && err.name === 'NotFoundError') {
                return (initDb());
            }
            if (err) {
                log.fatal({ 'error': errToObj(err) },
                          'Error finding index in db');
                return (self.emit('error', err));
            }
            opts.db.get(CLUSTER_CONFIG_KEY, function (err2, ccIndexVal) {
                //There must be a cluster config index if there is a last log
                // index.
                if (err2) {
                    log.fatal({ 'error': errToObj(err2) },
                              'Error finding cluster config in db');
                    return (self.emit('error', err2));
                }
                lastIndex = lastIndexVal;
                clusterConfigIndex = ccIndexVal;
                setupSelf();
            });
        });
    }

    //If there's an open db passed in, then skip opening it ourselves.
    if (opts.db !== null && opts.db !== undefined) {
        return (findLastIndexAndClusterIndex());
    }

    log.debug({ 'opts.location': opts.location },
              'opening/initing leveldb log');
    dbHelpers.createOrOpen(opts, function (err, res) {
        if (err) {
            return (self.emit('error', err));
        }

        opts.db = res.db;
        findLastIndexAndClusterIndex();
    });
}



///--- Internal classes

function ValueTransform(a) {
    stream.Transform.call(this, { 'objectMode': true });
}
util.inherits(ValueTransform, stream.Transform);

ValueTransform.prototype._transform = function (data, encoding, cb) {
    if ((typeof (data)) === 'object') {
        if (data.value !== undefined) {
            data = data.value;
        }
    }
    this.push(data);
    cb();
};



///--- API

//TODO: A better way?
LevelDbLog.prototype.from = function from(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.db, 'opts.db');
    assert.object(opts.stateMachine, 'opts.stateMachine');

    var self = this;
    var l = new LevelDbLog({
        'log': self.log,
        'db': opts.db,
        'stateMachine': opts.stateMachine
    });
    l.on('ready', function () {
        return (cb(null, l));
    });
    l.on('error', function (err) {
        return (cb(err));
    });
};


LevelDbLog.prototype.append = function append(opts, cb) {
    assert.object(opts, 'opts');
    assert.number(opts.commitIndex, 'opts.commitIndex');
    assert.number(opts.term, 'opts.term');
    assert.object(opts.entries, 'opts.entries');

    var self = this;
    var log = self.log;
    var db = self.db;
    var commitIndex = opts.commitIndex;
    var term = opts.term;
    var entries = opts.entries;
    var firstEntry = null;
    var level = null;
    var ended = false;
    var entriesEnded = false;
    var psEnded = false;
    var lastEntry = null;

    log.debug('append start');
    if (self.open === false) {
        return (setImmediate(cb.bind(
            null, new error.InternalError('Attempt to use leveldb_log before ' +
                                          'fully initialized'))));
    }

    function end(err, entry) {
        log.debug('something called end');
        if (ended) {
            if (err) {
                log.error(err, 'err after already ended');
            }
            return;
        }

        if (level !== null) {
            log.debug('removing all level listeners');
            level.removeAllListeners();
            //Note that this destroy is on the iterator *not the db*.
            level.destroy();
        }
        log.debug('removing all entries listeners');
        entries.removeAllListeners();
        ended = true;

        //Final sanity checking

        //Checking to see that the final entry index is at or more than the
        // commit index of the request.  If it's not, we have to error.
        // Otherwise, the leader will set the commit index for this node ahead
        // of where it actually is (that's a bad thing).
        log.debug({ err: err, entriesEnded: entriesEnded, psEnded: psEnded,
                    commitIndex: commitIndex,
                    lastEntry: lastEntry }, 'checking final');
        if (!err && (entriesEnded || psEnded) &&
            lastEntry !== null && commitIndex > lastEntry.index) {
            log.debug('last entry index is behind the commit index');
            err = new error.InvalidIndexError(sprintf(
                'commit index %d is ahead of the entry index %d',
                commitIndex, lastEntry.index));
        }

        log.debug('append end');
        return (cb(err, entry));
    }

    function onTransitionalEntryEnd() {
        entriesEnded = true;
    }

    function onFirstLevelEnd() {
        //This means that the entry isn't in the log yet, so we close
        // everything and fail out.
        log.debug('ending due to first level end');
        return (end(new error.TermMismatchError(sprintf(
            'no clog entry at index %d', firstEntry.index))));
    }

    function onFirstLevelError(err) {
        log.error(errToObj(err), 'on first level error');
        return (end(err));
    }

    function onFirstLevelReadable() {
        var firstLevel = level.read();
        if (firstLevel === null) {
            level.once('readable', onFirstLevelReadable);
            return;
        }
        log.debug('first level read');
        entries.removeListener('end', onTransitionalEntryEnd);
        level.removeListener('error', onFirstLevelError);
        level.removeListener('end', onFirstLevelEnd);
        firstLevel = firstLevel.value;

        //Now we have the first entry from both streams and we can do the
        // consistency check.
        if (firstLevel.index !== firstEntry.index ||
            firstLevel.term !== firstEntry.term) {
            log.debug({
                'levelIndex': firstLevel.index,
                'levelTerm': firstLevel.term,
                'entryIndex': firstEntry.index,
                'entryTerm': firstEntry.term
            }, 'ending due to term mismatch');
            return (end(new error.TermMismatchError(sprintf(
                'at entry %d, command log term %d doesn\'t match %d',
                firstEntry.index, firstLevel.term, firstEntry.term))));
        }

        //If we caught an end event for the entries while we were waiting for
        // reading from the leveldb, we can just end here.
        if (entriesEnded) {
            log.debug('ending due to transitional entries ending');
            return (end());
        }

        var ps = new PairsStream({ 'left': entries, 'right': level });

        var outstandingPuts = 0;
        var successfulPuts = 0;
        var outstandingGets = 0;
        var successfulGets = 0;
        var trackingIndex = firstEntry.index + 1;
        var trackingTerm = firstEntry.term;
        var truncated = false;
        var stateMachine = self.stateMachine;

        function tryEnd() {
            log.debug({  'outstandingPuts': outstandingPuts,
                         'successfulPuts': successfulPuts,
                         'outstandingGets': outstandingGets,
                         'successfulGets': successfulGets,
                         'psEnded': psEnded
                      }, 'trying end');
            if (!psEnded ||
                (outstandingPuts !== successfulPuts) ||
                (outstandingGets !== successfulGets)) {
                return;
            }
            log.debug({ 'outstandingPuts': outstandingPuts,
                        'successfulPuts': successfulPuts,
                        'outstandingGets': outstandingGets,
                        'successfulGets': successfulGets },
                      'ending because the pairs stream has ended and ' +
                      'all entries have been flushed.');
            return (end());
        }

        function forcePsEnd(err) {
            log.debug('removing all ps listeners');
            ps.removeAllListeners();
            return (end(err));
        }

        function nextPairReadable() {
            var pair = ps.read();
            if (pair === null) {
                //We'll wait for the next 'readable' event or this is the end.
                return (tryEnd());
            }

            log.debug({ 'pair': pair }, 'pair read');
            var e = pair.left;
            //Walk down to the value for the level db record
            var l = (pair.right === undefined || pair.right === null) ?
                pair.right : pair.right.value;

            //The entries ending means we can just stop, but after all the
            // writes are flushed.
            if (e === undefined || e === null) {
                //We lie here because, for all intents and purposes, we
                // don't care to read the rest of the ps stream.  The
                // cleanup for the two streams are done elsewhere.
                log.debug('removing all ps listeners, fake end');
                ps.removeAllListeners();
                psEnded = true;
                return (tryEnd());
            }
            lastEntry = e;

            //Verify that the indexes are strictly increasing
            if (e.index !== trackingIndex) {
                log.debug('ending because entry index isnt strictly ' +
                          'increasing.');
                return (forcePsEnd(new error.InvalidIndexError(sprintf(
                    'entry index isn\'t strictly increasing at %d',
                    e.index))));
            }
            ++trackingIndex;

            //And the term is increasing
            if (e.term < trackingTerm) {
                log.debug('ending because entry term is less than ' +
                          'tracking term.');
                return (forcePsEnd(new error.InvalidTermError(sprintf(
                    'term %d isn\'t strictly increasing at index %d',
                    e.term, e.index))));
            }
            trackingTerm = e.term;

            //Verify that the entries don't have a term past raft's term
            if (term < e.term) {
                log.debug('ending because term is less than entry term');
                return (forcePsEnd(new error.InvalidTermError(sprintf(
                    'request term %d is behind the entry term %d',
                    term, e.term))));
            }

            function tryEntryWrite() {
                //If the leveldb goes null, that means we can blast the rest
                // of the pairs stream into leveldb.
                //TODO: Should we just to one big batch at the end or several
                // smaller batches?  All the little fsyncs are going to kill us.
                // Or maybe we can just fsync at the very end?  Also, putting
                // the index each time sucks.  Doing a real batch here is *much*
                // smarter.  We're going to have to perf-test this and see what
                // the right thing to do is.
                if (l === undefined || l === null || truncated) {
                    ++outstandingPuts;
                    log.debug({ 'entry': e }, 'putting entry');
                    var batch = [
                        { 'type': 'put',
                          'key': logKey(e.index),
                          'value': e
                        },
                        { 'type': 'put',
                          'key': LAST_INDEX_KEY,
                          'value': e.index
                        }
                    ];

                    //Cluster Reconfigurations
                    var reconfigure = false;
                    if ((typeof (e.command)) === 'object' &&
                        e.command.to === 'raft' &&
                        e.command.execute === 'configure' &&
                        e.command.cluster &&
                        e.index > self.clusterConfigIndex) {
                        //We could also make a linked list in the leveldb, but
                        // it seems safer to keep it with the entry, even if it
                        // does mean modifying the entry.
                        e.command.cluster.prevClogIndex =
                            self.tempLatestClusterConfigIndex ||
                            self.clusterConfigIndex;
                        batch.push({
                            'type': 'put',
                            'key': CLUSTER_CONFIG_KEY,
                            'value': e.index
                        });
                        //Unfortunately, we need to keep some state around as
                        // the stream comes in so that we get the right chain
                        // since the async call below means we won't update the
                        // clusterConfigIndex until the call returns.
                        if (self.tempLatestClusterConfigIndex === undefined ||
                            e.index > self.tempLatestClusterConfigIndex) {
                            self.tempLatestClusterConfigIndex = e.index;
                        }
                        reconfigure = true;
                    }

                    db.batch(batch, SYNC_OPTIONS, function (err) {
                        log.debug({ 'entry': e }, 'entry put done');
                        if (err) {
                            log.error({ 'error': errToObj(err), 'entry': e },
                                      'error putting entry, forcing end.');
                            return (forcePsEnd(err));
                        }
                        //Only ever increasing...
                        if (e.index > self.lastEntry.index) {
                            self.nextIndex = e.index + 1;
                            self.lastEntry = e;
                        }
                        if (reconfigure && e.index > self.clusterConfigIndex) {
                            self.clusterConfigIndex = e.index;
                            self.clusterConfig = deepcopy(e.command.cluster);
                            self.clusterConfig.clogIndex = e.index;
                            //Remove the temp state only if it's the same
                            // change.
                            if (self.tempLatestClusterConfigIndex === e.index) {
                                delete self.tempLatestClusterConfigIndex;
                            }
                        }
                        ++successfulPuts;
                        nextPairReadable();
                    });
                } else {
                    nextPairReadable();
                }
            }

            //Check truncation
            if (l !== null && l !== undefined && !truncated) {
                //Sanity checking...
                if (e.index !== l.index) {
                    log.debug('ending because indexes arent equal');
                    return (forcePsEnd(new error.InvalidIndexError(sprintf(
                        'entry index %d doesn\'t equal db index %d in ' +
                            'pairs stream', e.index, l.index))));
                }

                //Truncate if we need to.  By setting this to true, the
                // entries will be written *including the index*,
                // effectively truncating the log.
                if (e.term !== l.term) {
                    //Up until now, all the records should have been
                    // read-and-verify only.  Since we're at the point where
                    // we'll actually do damage (truncation), we do some
                    // sanity checking.
                    if (stateMachine.commitIndex >= e.index) {
                        var message = sprintf(
                            'attempt to truncate before state machine\'s ' +
                                'commit index', e.index);
                        log.error({
                            'stateMachineIndex': stateMachine.commitIndex,
                            'oldEntry': l,
                            'newEntry': e
                        }, message);
                        return (forcePsEnd(
                            new error.InternalError(message)));
                    }
                    log.debug('truncating');

                    //Walk the links back to find the last config, then continue
                    // with the writes.  The ++outstandingGets makes is so that
                    // we don't end prematurely.
                    ++outstandingGets;
                    function walkBack() {
                        if (e.index > self.clusterConfigIndex) {
                            ++successfulGets;
                            truncated = true;
                            //If we don't do this here, we won't correctly set
                            // the internal state correctly.
                            self.nextIndex = e.index + 1;
                            self.lastEntry = e;
                            return (tryEntryWrite());
                        }
                        log.debug({
                            'eindex': e.index,
                            'ccIndex': self.clusterConfigIndex
                        }, 'walking back another step');
                        var pIndex = self.clusterConfig.prevClogIndex;
                        self.db.get(logKey(pIndex), function (err, pe) {
                            if (err) {
                                message =
                                    'error fetching prev (bad prevClogIndex?)';
                                log.error({
                                    'cluster': self.clusterConfig,
                                    'error': err
                                }, message);
                                return (forcePsEnd(
                                    new error.InternalError(message)));
                            }
                            self.clusterConfigIndex = pIndex;
                            self.clusterConfig = deepcopy(pe.command.cluster);
                            self.clusterConfig.clogIndex = pIndex;
                            walkBack();
                        });
                    }
                    walkBack();
                } else {
                    tryEntryWrite();
                }
            } else {
                tryEntryWrite();
            }
        }

        ps.on('readable', function () {
            nextPairReadable();
        });

        ps.on('end', function () {
            psEnded = true;
            tryEnd();
        });
    }

    function onFirstEntryEnd() {
        if (firstEntry !== null) {
            //The onFirstEntryReadable should take care of this.
            return;
        }
        log.debug('ending on first entry end, null');
        entriesEnded = true;
        return (end());
    }

    function onFirstEntryError(err) {
        log.error(errToObj(err), 'on first entry error');
        return (end(err));
    }

    function onFirstEntryReadable() {
        firstEntry = entries.read();
        if (firstEntry === null) {
            entries.once('readable', onFirstEntryReadable);
            return;
        }
        log.debug('first entry read');
        lastEntry = firstEntry;
        entries.removeListener('error', onFirstEntryError);
        entries.removeListener('end', onFirstEntryEnd);

        //Sanity check.  We'll blow up if the term < 0
        if (firstEntry.index < 0) {
            var tmerr = new error.TermMismatchError(sprintf(
                'at entry %d, term %d is invalid', firstEntry.index,
                firstEntry.term));
            return (end(tmerr));
        }

        //A single put.
        //TODO: This has to be done in serial, and in batches, otherwise
        // performance is going to be *horrible*.
        if (firstEntry.index === undefined) {
            //TODO: Check that the entry has all the right fields
            firstEntry.index = self.nextIndex;
            ++self.nextIndex;
            var batch = [
                { 'type': 'put',
                  'key': logKey(firstEntry.index),
                  'value': firstEntry
                },
                { 'type': 'put',
                  'key': LAST_INDEX_KEY,
                  'value': firstEntry.index
                }
            ];

            //TODO: Refactor so that we don't have the copy/paste with the
            // tryEntryWrite.  We don't need to worry about truncation here...
            var reconfigure = false;
            if ((typeof (firstEntry.command)) === 'object' &&
                firstEntry.command.to === 'raft' &&
                firstEntry.command.execute === 'configure' &&
                firstEntry.command.cluster &&
                firstEntry.index > self.clusterConfigIndex) {
                //We could also make a linked list in the leveldb, but
                // it seems safer to keep it with the entry, even if it
                // does mean modifying the entry.
                firstEntry.command.cluster.prevClogIndex =
                    self.tempLatestClusterConfigIndex ||
                    self.clusterConfigIndex;
                batch.push({
                    'type': 'put',
                    'key': CLUSTER_CONFIG_KEY,
                    'value': firstEntry.index
                });
                //Unfortunately, we need to keep some state around as
                // the stream comes in so that we get the right chain
                // since the async call below means we won't update the
                // clusterConfigIndex until the call returns.
                if (self.tempLatestClusterConfigIndex === undefined ||
                    firstEntry.index > self.tempLatestClusterConfigIndex) {
                    self.tempLatestClusterConfigIndex = firstEntry.index;
                }
                reconfigure = true;
            }

            //TODO: If this fails, we're going to get holes in the log... this
            // would be addressed by the "batch" work, above.
            db.batch(batch, SYNC_OPTIONS, function (err) {
                if (firstEntry.index > self.lastEntry.index) {
                    self.lastEntry = firstEntry;
                }
                if (reconfigure && firstEntry.index > self.clusterConfigIndex) {
                    self.clusterConfigIndex = firstEntry.index;
                    self.clusterConfig = deepcopy(firstEntry.command.cluster);
                    self.clusterConfig.clogIndex = firstEntry.index;
                    //Remove the temp state only if it's the same
                    // changfirstEntry.
                    if (self.tempLatestClusterConfigIndex ===
                        firstEntry.index) {
                        delete self.tempLatestClusterConfigIndex;
                    }
                }
                log.debug('ending on single put');
                return (end(err, firstEntry));
            });
            return;
        }

        //Otherwise, we start reading from a leveldb iterator.
        log.debug('starting read from leveldb');
        level = db.createReadStream({
            'start': logKey(firstEntry.index),
            'end': logKey(self.nextIndex - 1)
        });

        level.once('readable', onFirstLevelReadable);
        level.once('error', onFirstLevelError);
        level.once('end', onFirstLevelEnd);
        //Adding this transitional listener guarentees we'll see the end
        // event for entries for as long as it takes to read from the leveldb.
        entries.on('end', onTransitionalEntryEnd);
    }

    log.debug('starting read from entries');
    entries.once('readable', onFirstEntryReadable);
    entries.once('error', onFirstEntryError);
    entries.once('end', onFirstEntryEnd);
};


LevelDbLog.prototype.slice = function slice(start, end, cb) {
    assert.number(start, 'index');
    if ((typeof (end)) === 'function') {
        cb = end;
        end = undefined;
    }
    assert.optionalNumber(end, 'index');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    if (self.open === false) {
        return (setImmediate(cb.bind(
            null, new error.InternalError('Attempt to use leveldb_log before ' +
                                          'fully initialized'))));
    }

    //Make sure we only go up to the end- the log itself could go further if
    // there was a previous truncation.
    if (end === undefined) {
        end = self.lastEntry.index;
    } else {
        //We subtract 1 here to make this function act like javascript's slice.
        end = Math.min(end - 1, self.lastEntry.index);
    }

    //Just nip it if there's nothing to slice.
    if (end < start) {
        return (setImmediate(cb.bind(null, null, memstream([]))));
    }

    log.debug({ 'start': start, 'end': end }, 'slicing');
    var rs = self.db.createReadStream({
        'start': logKey(start),
        'end': logKey(end)
    });
    var vt = new ValueTransform();
    rs.pipe(vt);
    setImmediate(cb.bind(null, null, vt));
};


LevelDbLog.prototype.last = function last() {
    var self = this;
    return (self.lastEntry);
};


LevelDbLog.prototype.close = function close(cb) {
    cb = cb || function () {};
    var self = this;
    if (self.open === false) {
        return (setImmediate(cb));
    }
    if (self.db.isOpen()) {
        self.db.close(function () {
            self.open = false;
            return (cb());
        });
    }
};


LevelDbLog.prototype.dump = function dump(cb) {
    cb = cb || function () {};
    var self = this;
    var db = self.db;
    db.createReadStream()
        .on('data', function (d) {
            console.log(JSON.stringify(d, null, 0));
        }).on('close', cb);
    return;
};
