/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var bunyan = require('bunyan');
var helper = require('../helper.js');
var lib = require('../../lib');
var memraft = require('../memory');
var nodeunitPlus = require('nodeunit-plus');
var vasync = require('vasync');

// All the actual tests are here...
var raftRequestVoteTests = require('../share/raft_requestvote_tests.js');



///--- Globals

var before = nodeunitPlus.before;
var createClusterConfig = helper.createClusterConfig;
var memstream = lib.memstream;
var LOG = bunyan.createLogger({
    level: (process.env.LOG_LEVEL || 'fatal'),
    name: 'raft-test',
    stream: process.stdout
});
var LOW_LEADER_TIMEOUT = 2;



///--- Setup/Teardown

before(function (cb) {
    var self = this;

    var clusterConfig = createClusterConfig([ 'raft-0', 'raft-1', 'raft-2' ]);
    var opts = {
        'log': LOG,
        'id': 'raft-0',
        'clusterConfig': clusterConfig
    };

    var e = helper.e(clusterConfig);
    self.e = e;
    //Need to "naturally" add some log entries, commit to state machines, etc.
    var raft;
    vasync.pipeline({
        funcs: [
            function init(o, subcb) {
                memraft.raft(opts, function (err, r) {
                    if (err) {
                        return (subcb(err));
                    }
                    raft = r;
                    return (subcb(null));
                });
            },
            function addEntries(o, subcb) {
                raft.appendEntries({
                    'operation': 'appendEntries',
                    'term': 3,
                    'leaderId': 'raft-1',
                    'entries': memstream([
                        e(0, 0),
                        e(1, 1),
                        e(2, 2),
                        e(3, 3)
                    ]),
                    'commitIndex': 2
                }, subcb);
            }
        ]
    }, function (err) {
        self.raft = raft;
        //Set the leaderTimout low...
        raft.leaderTimeout = LOW_LEADER_TIMEOUT;
        return (cb(err));
    });
});
