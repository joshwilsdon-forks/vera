/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var helper = require('../helper.js');
var lib = require('../../lib');
var memlib = require('../../lib/memory');
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');


///--- Globals

var createClusterConfig = helper.createClusterConfig;



///--- Funcs

function raft(opts, cb) {
    assert.object(opts);
    assert.object(opts.log, 'opts.log');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.clusterConfig, 'opts.clusterConfig');
    assert.optionalObject(opts.messageBus, 'opts.messageBus');
    assert.func(cb, 'cb');

    var log = opts.log;

    var r;
    vasync.pipeline({
        arg: opts,
        funcs: [
            function initMessageBus(_, subcb) {
                if (_.messageBus === undefined) {
                    _.messageBus = new memlib.MessageBus({ 'log': log });
                    _.messageBus.on('ready', subcb);
                } else {
                    subcb();
                }
            },
            function initStateMachine(_, subcb) {
                _.stateMachine = new memlib.StateMachine({ 'log': log });
                _.stateMachine.on('ready', subcb);
            },
            function initMemLog(_, subcb) {
                _.clog = new memlib.CommandLog({ 'log': log,
                                      'stateMachine': _.stateMachine,
                                      'clusterConfig': opts.clusterConfig });
                _.clog.on('ready', subcb);
            },
            function initMemProps(_, subcb) {
                _.properties = new memlib.Properties({
                    'log': log,
                    'props': {
                        'currentTerm': 0
                    }
                });
                _.properties.on('ready', subcb);
            },
            function initSnapshotter(_, subcb) {
                _.snapshotter = new memlib.Snapshotter({
                    'log': log
                });
                _.snapshotter.on('ready', subcb);
            },
            function initRaft(_, subcb) {
                r = new lib.Raft(opts);
                r.once('stateChange', function (state) {
                    if (state !== 'follower') {
                        return (subcb(new Error(
                            'new raft transitioned to something other than ' +
                                'follower')));
                    }
                    subcb();
                });
            }
        ]
    }, function (err) {
        if (err) {
            return (cb(err));
        }
        return (cb(null, r));
    });
}


function refreshPeers(c) {
    var self = c || this;
    Object.keys(self.messageBus.peers).forEach(function (id) {
        if (self.peers[id] === undefined) {
            self.peers[id] = self.messageBus.peers[id];
        }
    });
}


function getLeader(c) {
    var self = c || this;
    var leader;
    Object.keys(self.peers).map(function (p) {
        var peer = self.peers[p];
        if (peer.state === 'leader') {
            if (leader !== undefined) {
                console.error(clusterToString(c));
                throw new Error('Multiple leaders detected');
            }
            leader = peer;
        }
    });
    return (leader);
}


function tick(c, cb) {
    if ((typeof (c)) === 'function') {
        cb = c;
        c = undefined;
    }
    var self = c || this;
    if (Object.keys(self.messageBus.messages).length > 0) {
        self.messageBus.tick(function () {
            return (setImmediate(cb));
        });
    } else {
        Object.keys(self.peers).forEach(function (p) {
            self.peers[p].tick();
        });
        return (setImmediate(cb));
    }
}


function raftSummary(r) {
    return (sprintf(
        '%s %9s term: %3d, t-out: %2d, leader: %s, commitIdx: %d\n',
        r.id, r.state, r.currentTerm(), r.leaderTimeout,
        r.leaderId === undefined ? 'undefd' : r.leaderId,
        r.stateMachine.commitIndex));
}


function messageBusSummary(m) {
    var s = '';
    s += sprintf(
        'Messages:%s\n',
        Object.keys(m.messages).length === 0 ? ' (none)' : '');
    Object.keys(m.messages).forEach(function (mi) {
        var me = m.messages[mi];
        var prefix = sprintf('%s -> %s', me.from, me.to);
        if (me.message.operation === 'requestVote') {
            s += sprintf(
                '  reqVote %s: term %3d, logIndex: %3d, logTerm: %3d\n',
                prefix, me.message.term, me.message.lastLogIndex,
                me.message.lastLogTerm);
        } else if (me.message.operation === 'appendEntries') {
            s += sprintf(
                '  appEntr %s: term %3d, leader: %s, commitIndex: %3d\n',
                prefix, me.message.term, me.message.leaderId,
                me.message.commitIndex);
        } else if (me.message.operation === 'installSnapshot') {
            s += sprintf(
                '  intSnap %s\n', prefix);
        } else {
            s += sprintf(
                ' unknown message: ', me);
        }
    });
    return (s);
}


function clusterToString(c) {
    var self = c || this;
    var s = '';

    //Peers
    Object.keys(self.peers).map(function (p) {
        s += raftSummary(self.peers[p]);
    });

    //Messages
    s += messageBusSummary(self.messageBus);
    return (s);
}


//Inits a set of raft peers, all connected with a single message bus.
function cluster(opts, cb) {
    assert.object(opts);
    assert.object(opts.log, 'opts.log');
    assert.number(opts.size, 'opts.size');
    assert.optionalBool(opts.electLeader, 'opts.electLeader');
    assert.optionalObject(opts.messageBus, 'opts.messageBus');
    assert.optionalNumber(opts.idOffset, 'opts.idOffset');

    //Only putting everything in here so you can see what will be returned.
    var c = {
        'messageBus': opts.messageBus,
        'peers': {},
        'refreshPeers': refreshPeers,
        'getLeader': getLeader,
        'tick': tick,
        'toString': clusterToString
    };
    var log = opts.log;
    var peers = [];
    var idOffset = opts.idOffset === undefined ? 0 : opts.idOffset;
    for (var i = 0; i < opts.size; ++i) {
        peers.push('raft-' + (i + idOffset));
    }
    vasync.pipeline({
        arg: {},
        funcs: [
            function initMessageBus(_, subcb) {
                if (c.messageBus === undefined) {
                    c.messageBus = new memlib.MessageBus({ 'log': log });
                    c.messageBus.on('ready', subcb);
                } else {
                    subcb();
                }
            },
            function initPeers(_, subcb) {
                var inited = 0;
                function tryEnd() {
                    ++inited;
                    if (inited === opts.size) {
                        subcb();
                    }
                }

                var clusterConfig = createClusterConfig(peers);
                peers.forEach(function (p) {
                    var o = {
                        'log': log,
                        'id': p,
                        'clusterConfig': clusterConfig,
                        'messageBus': c.messageBus
                    };
                    raft(o, function (err, peer) {
                        c.peers[p] = peer;
                        tryEnd();
                    });
                });
            },
            function electLeader(_, subcb) {
                if (opts.electLeader === undefined ||
                    opts.electLeader === false) {
                    return (subcb());
                }

                var x = 0;
                var s = '';
                function tryOnce() {

                    //Error out if this is taking "too long".  This is really
                    // just a safety valve so I don't have infinite loops.
                    // Alternatively, I could just set the election timeout
                    // really low on raft-0, but I might as well excercise
                    // leader election as much as possible.
                    s += sprintf('%d:\n%s\n', x, c.toString());
                    if (x++ === 1000) {
                        console.error(s);
                        return (subcb(
                            new Error('leader election took too long')));
                    }

                    //End condition is when there is one leader and the rest
                    // followers.
                    var states = { 'leader': 0, 'follower': 0, 'candidate': 0 };
                    Object.keys(c.peers).forEach(function (p) {
                        ++states[c.peers[p].state];
                    });
                    if (states['leader'] === 1 &&
                        states['follower'] === peers.length - 1) {
                        return (subcb());
                    }

                    //Otherwise, move the cluster along...
                    c.tick(tryOnce);
                }
                tryOnce();
            }
        ]
    }, function (err) {
        if (err) {
            return (cb(err));
        }
        cb(null, c);
    });
}



///--- Exports
module.exports = {
    'cluster': cluster,
    'raft': raft,
    'raftSummary': raftSummary,
    'messageBusSummary': messageBusSummary
};
