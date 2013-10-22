// Copyright (c) 2013, Joyent, Inc. All rights reserved.

var assert = require('assert-plus');
var error = require('./error');
var events = require('events');
var vasync = require('vasync');
var util = require('util');



/**
 * Emits:
 * - stateChange: When this raft instance transitions to a new state.
 */



///--- Globals (ie things that should be configurable, but aren't yet)

var TICK_MIN = 5;
var TICK_MAX = 10;
var STATES = {
    'leader': 'leader',
    'candidate': 'candidate',
    'follower': 'follower'
};
var CURRENT_TERM = 'currentTerm';
var VOTED_FOR = 'votedFor';



///--- Functions

function Raft(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.id, 'opts.id');
    assert.arrayOfString(opts.peers, 'opts.peers');
    assert.object(opts.clog, 'opts.clog');
    assert.object(opts.stateMachine, 'opts.stateMachine');
    assert.object(opts.messageBus, 'opts.messageBus');
    //Should properties just be a part of the command log?
    assert.object(opts.properties, 'opts.properties');

    var self = this;
    self.id = opts.id;
    self.log = opts.log.child({ 'id': self.id });
    self.leaderId = undefined;

    //This is set in the resetTicker function.  The ticker is used to transition
    // to a candidate (if follower or candidate), or send heartbeats to
    // followers (if leader).
    self.leaderTimeout = undefined;
    self.properties = opts.properties;
    self.peers = [];
    //Filter me out of the peers.
    opts.peers.forEach(function (p) {
        if (p !== opts.id) {
            self.peers.push(p);
        }
    });

    self.clog = opts.clog;
    self.stateMachine = opts.stateMachine;

    self.messageBus = opts.messageBus;
    if (self.messageBus.peers[self.id] === undefined) {
        self.messageBus.register(self);
    }
    self.outstandingMessages = {};

    self.resetTicker();
    self.transitionToFollower();
}

util.inherits(Raft, events.EventEmitter);
module.exports = Raft;



///--- API

Raft.prototype.currentTerm = function () {
    var self = this;
    return (self.properties.get(CURRENT_TERM));
};


Raft.prototype.votedFor = function () {
    var self = this;
    return (self.properties.get(VOTED_FOR));
};


Raft.prototype.updateTerm = function (term, cb) {
    var self = this;
    var log = self.log;
    var oldTerm = self.properties.get(CURRENT_TERM);
    //TODO: This is a bad- means we have a race condition somewhere
    if (oldTerm >= term) {
        return (process.nextTick(cb));
    }
    self.properties.write({
        'currentTerm': term,
        'votedFor': undefined
    }, function (err) {
        self.leaderId = undefined;
        log.debug({ 'term': term }, 'updated term and cleared ' +
                  'votedFor/leaderID');
        //TODO: Err?
        return (cb(null));
    });
};


Raft.prototype.updateVotedFor = function (vf, cb) {
    var self = this;
    var log = self.log;
    self.properties.write({
        'votedFor': vf
    }, function (err) {
        log.debug({ 'votedFor': vf }, 'updated votedFor');
        //TODO: Err?
        return (cb(null));
    });
};


//TODO: The other two functions should probably go away in favor of this.
Raft.prototype.updateTermAndVotedFor = function (term, votedFor, cb) {
    var self = this;
    var log = self.log;
    var oldTerm = self.properties.get(CURRENT_TERM);
    //TODO: This is a bad- means we have a race condition somewhere
    if (oldTerm >= term) {
        return (process.nextTick(cb));
    }
    self.properties.write({
        'currentTerm': term,
        'votedFor': votedFor
    }, function (err) {
        self.leaderId = undefined;
        log.debug({ 'term': term, 'votedFor': votedFor },
                  'updated term/votedFor and cleared leaderId');
        //TODO: Err?
        return (cb(null));
    });
};


//TODO: Should be fairly simple to get a race condition here since the
// only asynchronous part is the term and vote persisting.  These requests
// should be choked.
Raft.prototype.requestVote = function (req, cb) {
    assert.object(req, 'request');
    assert.number(req.term, 'request.term');
    assert.string(req.candidateId, 'request.candidateId');
    assert.number(req.lastLogIndex, 'request.lastLogIndex');
    assert.number(req.lastLogTerm, 'request.lastLogTerm');

    var self = this;
    var log = self.log;
    var voteGranted = false;
    var currentTerm = self.currentTerm();
    var votedFor = self.votedFor();
    var termChanged = false;

    log.debug({ 'request': req }, 'processing voted for');

    function end(err) {
        var result = {
            'term': currentTerm,
            'voteGranted': voteGranted
        };
        log.debug({ 'err': err, 'result': result }, 'Leaving appendEntries');
        return (cb(err, result));
    }

    if (req.term < currentTerm) {
        log.debug({ 'currentTerm': currentTerm,
                    'requestTurm': req.term },
                  'Term is out of date in request, dropping it.');
        return (process.nextTick(
            end.bind(null, new error.InvalidTermError('outdated term'))));
    }

    if (req.term > currentTerm) {
        log.debug({ 'currentTerm': currentTerm,
                    'requestTurm': req.term },
                  'My term is out of date.');
        //Will update this later...
        termChanged = true;
        currentTerm = req.term;
        votedFor = undefined;
        if (self.state === STATES.candidate ||
            self.state === STATES.leader) {
            log.debug({ 'term': currentTerm, 'state': self.state },
                      'Stepping down.');
            self.transitionToFollower();
        }
    }

    //Already voted for this leader, this term.
    if (votedFor === req.candidateId) {
        log.debug({ 'votedFor': votedFor },
                  'already voted for this candidate');
        voteGranted = true;
        return (process.nextTick(end));
    }

    var last = self.clog.last();
    voteGranted =
        //Vote hasn't been casted for this term yet AND
        votedFor === undefined &&
        //Your term is greater than my term OR
        ((last.term < req.lastLogTerm) ||
         //We have the same term and your index is as/more up to date
         (last.term === req.lastLogTerm &&
          last.index <= req.lastLogIndex));

    //The only time an update isn't needed is when we didn't cast a vote and
    // the term was updated.
    if (voteGranted || termChanged) {
        votedFor = voteGranted ? req.candidateId : undefined;
        self.updateTermAndVotedFor(currentTerm, votedFor, function () {
            log.debug({ 'term': currentTerm,
                        'votedFor': self.votedFor(),
                        'clogIndex': last.index,
                        'reqIndex': req.lastLogIndex }, 'vote response');
            if (voteGranted) {
                self.resetTicker();
            }
            return (end());
        });
    } else {
        return (process.nextTick(end));
    }
};


Raft.prototype.appendEntries = function (req, cb) {
    assert.object(req, 'request');
    assert.number(req.term, 'request.term');
    assert.string(req.leaderId, 'request.leaderId');
    assert.number(req.prevLogIndex, 'request.prevLogIndex');
    assert.number(req.prevLogTerm, 'request.prevLogTerm');
    assert.arrayOfObject(req.entries, 'request.entries');
    assert.number(req.commitIndex, 'request.commitIndex');

    var self = this;
    var log = self.log;
    var currentTerm = self.currentTerm();

    log.debug({ 'request': req }, 'Entering appendEntries');

    function verifyTermAndStatus(_, subcb) {
        if (req.term < currentTerm) {
            log.debug({ 'currentTerm': currentTerm,
                        'requestTurm': req.term },
                      'Term is out of date in request, dropping it.');
            return (subcb(new error.InvalidTermError('outdated term')));
        }
        //TODO: Verify that the leader hasn't changed for this term, log error
        if (req.term !== currentTerm) {
            log.debug({ 'currentTerm': currentTerm,
                        'requestTurm': req.term },
                      'My term is out of date.');
            currentTerm = req.term;
            self.updateTerm(req.term, function () {
                self.leaderId = req.leaderId;
                return (subcb(null));
            });
        } else {
            return (subcb(null));
        }
    }

    function checkState(_, subcb) {
        if (self.state === STATES.candidate || self.state === STATES.leader) {
            log.debug({ 'term': currentTerm, 'state': self.state },
                      'Stepping down.');
            self.transitionToFollower();
        }
        return (subcb(null));
    }

    function resetTicker(_, subcb) {
        self.resetTicker();
        return (subcb(null));
    }

    function appendToCLog(_, subcb) {
        //This will verify that that the log is consistent before appending.
        self.clog.append({
            'prevIndex': req.prevLogIndex,
            'prevTerm': req.prevLogTerm,
            'entries': req.entries
        }, subcb);
    }

    //TODO: These should be moved out into a private function...
    function getLatestEntries(_, subcb) {
        var smIndex = self.stateMachine.commitIndex;
        if (smIndex >= req.commitIndex) {
            return (subcb(null));
        }

        self.clog.slice(smIndex, req.commitIndex, function (err, entries) {
            if (err) {
                log.error({ 'err': err,
                            'smIndex': smIndex,
                            'reqIndex': req.commitIndex
                          },
                          'error getting log entries');
                return (subcb(err));
            }
            _.entries = entries;
            return (subcb(null));
        });
    }

    function executeEntries(_, subcb) {
        if (_.entries === undefined || _.entries.length < 1) {
            return (subcb(null));
        }

        self.stateMachine.execute(_.entries, function (err) {
            if (err) {
                log.error({ 'err': err, 'entries': _.entries },
                          'error executing entries on state machine');
            }
            return (subcb(err));
        });
    }

    vasync.pipeline({
        funcs: [
            verifyTermAndStatus,
            resetTicker,
            appendToCLog,
            getLatestEntries,
            executeEntries
        ],
        arg: {}
    }, function (err) {
        var result = {
            'term': currentTerm,
            'success': err === undefined
        };
        log.debug({ 'err': err, 'result': result }, 'Leaving appendEntries');
        return (cb(err, result));
    });
};


Raft.prototype.clientRequest = function (req, cb) {
    assert.object(req, 'req');
    assert.func(cb, 'cb');
    //TODO: This obviously isn't the correct datatype.
    assert.string(req.command, 'req.command');

    var self = this;
    var log = self.log;
    var entry = {
        'term': self.currentTerm(),
        'command': req.command
    };

    log.debug({ 'req': req }, 'Entering clientRequest');

    function verifyImLeader(_, subcb) {
        if (self.state !== STATES.leader) {
            return (subcb(new error.NotLeaderError('I\'m not the leader')));
        }
        return (subcb(null));
    }

    function appendToCLog(_, subcb) {
        self.clog.append([ entry ], function (err, res) {
            if (err) {
                return (subcb(err));
            }
            entry.index = res.index;
            return (subcb(null));
        });
    }

    function appendEntry(_, subcb) {
        self.sendAppendEntries(entry.index, subcb);
    }

    //TODO: Because of the asynchronous fun of node, this is *not* the
    // correct way of doing this unless the state machine is smart enough
    // to hold onto out of order entries.
    function executeEntry(_, subcb) {
        self.stateMachine.execute([ entry ], function (err) {
            if (err) {
                log.error({ 'err': err, 'entries': _.entries },
                          'error executing entries on state machine');
            }
            return (subcb(err));
        });
    }

    vasync.pipeline({
        funcs: [
            verifyImLeader,
            appendToCLog,
            appendEntry,
            executeEntry
        ],
        arg: {}
    }, function (err) {
        var result = {
            'leaderId': self.leaderId,
            'entryTerm': entry.term,
            'entryIndex': entry.index,
            'success': err === undefined
        };
        log.debug({ 'err': err, 'result': result }, 'Leaving appendEntries');
        return (cb(err, result));
    });
};


Raft.prototype.sendAppendEntries = function () {
    //TODO: These need to be choked.
    var self = this;
    var log = self.log;

    log.debug('sending appendEntries');

    function getAppendEntries(peer, subcb) {
        //TODO: Need to fix this for the first log entry....
        var peerIndex = self.peerIndexes[peer];
        //Take as much as we can for now...
        self.clog.slice(peerIndex - 1, function (err, entries) {
            //TODO: Check error

            return (subcb(err, {
                'operation': 'appendEntries',
                'term': self.currentTerm(),
                'leaderId': self.leaderId,
                'entries': entries,
                'commitIndex': self.stateMachine.commitIndex
            }));
        });
    }

    function onResponse(err, from, res) {
        //TODO: What to do about the error?

        if (res.term > self.currentTerm() &&
            self.state !== STATES.follower) {
            return (self.updateTerm(res.term, function () {
                self.transitionToFollower();
            }));
        }

        //TODO: What about mismatched term?
        if (err && err.name === 'IndexMismatchError') {
            --self.peerIndexes[from];
            getAppendEntries(from, function (err2, appendRequest) {
                //TODO: err2?
                self.send(from, appendRequest, onResponse);
            });
            return;
        }

        //START HERE: TODO: Get entries from somewhere???
        //if (res.success) {
        //    self.peerIndexes[from] = entries[-1].index + 1;
        //}
    }

    self.peers.forEach(function (peer) {
        getAppendEntries(peer, function (err, appendRequest) {
            self.send(peer, appendRequest, onResponse);
        });
    });
};


Raft.prototype.transitionToLeader = function () {
    var self = this;
    var log = self.log;
    log.debug('transitioning to leader');
    self.clearOutstandingMessages();

    var last = self.clog.last();
    var nextIndex = last.index + 1;
    self.peerIndexes = {};
    self.peers.forEach(function (peer) {
        self.peerIndexes[peer] = nextIndex;
    });

    //TODO: See the docs, but only doing this, then accepting client requests
    // will lead to an eventually consistent client read.  It needs to be fixed
    // somehow.
    self.sendAppendEntries();
    self.leaderId = self.id;
    self.state = STATES.leader;
    process.nextTick(function () {
        self.emit('stateChange', self.state);
    });
};


Raft.prototype.transitionToCandidate = function () {
    var self = this;
    var log = self.log;
    log.debug('transitioning to candidate');
    self.clearOutstandingMessages();
    self.state = STATES.candidate;

    var newTerm = self.currentTerm() + 1;
    var receivedMajority = false;

    vasync.pipeline({
        arg: {},
        funcs: [
            function updatePersistantState(_, subcb) {
                self.updateTermAndVotedFor(newTerm, self.id, subcb);
            },
            function resetTicket(_, subcb) {
                self.resetTicker();
                subcb();
            },
            function sendRequestVotes(_, subcb) {
                var last = self.clog.last();
                var requestVote = {
                    'operation': 'requestVote',
                    'term': newTerm,
                    'candidateId': self.id,
                    'lastLogIndex': last.index,
                    'lastLogTerm': last.term
                };
                var votesFrom = [];
                var majority = (self.peers.length / 2) + 1;

                function onResponse(err, from, res) {
                    //TODO: Check err?
                    if (res.term > self.currentTerm() &&
                        self.state !== STATES.follower) {
                        self.updateTerm(res.term, function () {
                            self.transitionToFollower();
                        });
                        return;
                    }

                    //All the other messages should be cleared after we
                    // transition to leader, but just in case...
                    if (receivedMajority) {
                        return;
                    }

                    if (votesFrom.indexOf(from) === -1) {
                        log.debug({ 'from': from }, 'got a vote');
                        votesFrom.push(from);
                    }

                    if (votesFrom.length >= majority) {
                        log.debug({
                            'votesFrom': votesFrom,
                            'majority': majority
                        }, 'recieved majority vote');
                        self.transitionToLeader();
                        receivedMajority = true;
                    }
                }

                self.peers.forEach(function (peer) {
                    self.send(peer, requestVote, onResponse);
                });

                //Since the transitions out of candidate happen independently,
                // we're officially a candidate after we fire off the messages.
                return (subcb(null));
            }
        ]
    }, function (err) {
        //TODO: Err?
        self.emit('stateChange', self.state);
    });
};


Raft.prototype.transitionToFollower = function () {
    var self = this;
    var log = self.log;
    log.debug('transitioning to follower');
    self.clearOutstandingMessages();
    self.state = STATES.follower;
    process.nextTick(function () {
        self.emit('stateChange', self.state);
    });
};



//--- Message Bus

Raft.prototype.send = function (peer, message, cb) {
    assert.string(peer, 'peer');
    assert.object(message, 'message');
    assert.func(cb, 'cb');

    var self = this;
    var log = self.log;

    function onResponse(err, mId, from, res) {
        log.debug({ 'err': err, 'messageId': mId, 'from': from,
                    'response': res }, 'got response from peer');
        if (self.outstandingMessages[mId]) {
            delete (self.outstandingMessages[mId]);
        }
        return (cb(err, from, res));
    }

    var messageId = self.messageBus.send(self.id, peer, message, onResponse);
    self.outstandingMessages[messageId] = 'sent';

    log.debug({ 'peer': peer, 'message': message, 'messageId': messageId },
              'sent message to peer');
};


Raft.prototype.clearOutstandingMessages = function () {
    var self = this;
    var log = self.log;

    log.debug('clearing outstanding messages');

    Object.keys(self.outstandingMessages).forEach(function (messageId) {
        self.messageBus.cancel(messageId);
    });

    self.outstandingMessages = {};
};



///--- Ticker

/**
 * Resets the leader election ticker.  Ticks is optional- if not given it
 * will result in a random number of seconds based on the interval this
 * instance is configured with.
 */
Raft.prototype.resetTicker = function (ticks) {
    assert.optionalNumber(ticks, 'ticks');
    var self = this;
    if (self.state === 'leader') {
        self.leaderTimeout = Math.max(1, TICK_MIN - 1);
    } else {
        self.leaderTimeout = ticks !== undefined ? ticks :
            Math.floor(Math.random() * (TICK_MAX - TICK_MIN + 1)) +
            TICK_MIN;
    }
    self.log.debug({ 'leaderTimeout': self.leaderTimeout },
                   'resetting ticker');
};


/**
 * Tick... tick... tick... BOOM!
 */
Raft.prototype.tick = function () {
    var self = this;
    --self.leaderTimeout;
    self.log.debug({ 'state': self.state,
                     'leaderTimeout': self.leaderTimeout },
                   'ticking');
    if (self.leaderTimeout === 0) {
        if (self.state === STATES.candidate || self.state === STATES.follower) {
            self.log.debug('leader timed out, transitioning to candidate');
            self.transitionToCandidate();
        } else {
            self.sendHeartbeats();
        }
    }
};