// Copyright (c) 2013, Joyent, Inc. All rights reserved.

var bunyan = require('bunyan');
var fs = require('fs');
var helper = require('../helper.js');
var leveldbIndex = require('../../lib/leveldb');
var LevelProps = require('../../lib/leveldb/properties');
var path = require('path');
var vasync = require('vasync');



///--- Globals

var test = helper.test;
var LOG = bunyan.createLogger({
    level: (process.env.LOG_LEVEL || 'fatal'),
    name: 'leveldb_properties-test',
    stream: process.stdout
});
var TMP_DIR = path.resolve(path.dirname(__dirname), '..') + '/tmp';
var DB_FILE = TMP_DIR + '/leveldb_properties_test.db';



///--- Tests

test('crud', function (t) {
    var props;
    vasync.pipeline({
        args: {},
        funcs: [
            function mkTmpDir(_, subcb) {
                fs.mkdir(TMP_DIR, function (err) {
                    if (err && err.code !== 'EEXIST') {
                        return (subcb(err));
                    }
                    return (subcb());
                });
            },
            function removeOldLevelDb(_, subcb) {
                helper.rmrf(DB_FILE, subcb);
            },
            function init(_, subcb) {
                props = new LevelProps({
                    'log': LOG,
                    'location': DB_FILE
                });
                props.on('ready', subcb);
            },
            function write(_, subcb) {
                t.equal(0, props.get('currentTerm'));
                t.ok(props.get('foo') === undefined);
                t.ok(props.get('bar') === undefined);
                var p = { 'foo': 'fval', 'bar': 'bval'};
                props.write(p, subcb);
            },
            function read(_, subcb) {
                t.equal('fval', props.get('foo'));
                t.equal('bval', props.get('bar'));
                subcb();
            },
            function update(_, subcb) {
                var p = { 'bar': 'bval2'};
                props.write(p, subcb);
            },
            function checkUpdate(_, subcb) {
                t.equal('fval', props.get('foo'));
                t.equal('bval2', props.get('bar'));
                subcb();
            },
            function del(_, subcb) {
                props.delete('bar', subcb);
            },
            function checkDel(_, subcb) {
                t.equal('fval', props.get('foo'));
                t.ok(props.get('bar') === undefined);
                subcb();
            },
            function closeLeveDb(_, subcb) {
                props.db.close(subcb);
            },
            //Reopen and get again.
            function openNew(_, subcb) {
                props = new LevelProps({
                    'log': LOG,
                    'location': DB_FILE
                });
                props.on('ready', subcb);
            },
            function readAgain(_, subcb) {
                t.equal('fval', props.get('foo'));
                t.ok(props.get('bar') === undefined);
                subcb();
            },
            function finalCloseLeveDb(_, subcb) {
                props.db.close(subcb);
            }
        ]
    }, function (err) {
        if (err) {
            t.fail(err);
        }
        t.done();
    });
});
