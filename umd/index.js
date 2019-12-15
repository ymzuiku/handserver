'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var mongodb = require('mongodb');
var fastify = _interopDefault(require('fastify'));
var fastifyCors = _interopDefault(require('fastify-cors'));
var lodash = require('lodash');
var crypto = _interopDefault(require('crypto'));
var NodeRSA = _interopDefault(require('node-rsa'));
var fs = _interopDefault(require('fs-extra'));
var path = require('path');

const db = (dbName) => db.getDb(dbName);
db.defaultDbName = '';
db.getDb = (dbName = db.defaultDbName) => null;
db.inited = false;
db.init = (uri = 'mongodb://127.0.0.1:27017', defaultDbName = 'test') => {
    if (db.inited) {
        return;
    }
    db.inited = true;
    db.defaultDbName = defaultDbName;
    return new Promise(res => {
        mongodb.MongoClient.connect(uri, {
            // useFindAndModify: false,
            useNewUrlParser: true,
            useUnifiedTopology: true,
        }).then(client => {
            db.getDb = dbName => client.db(dbName || db.defaultDbName);
            res();
        });
    });
};

const app = fastify({
    logger: true,
    disableRequestLogging: true,
});
const setCors = () => app.register(fastifyCors);

const sha256 = (str, slat) => {
    const obj = crypto.createHash('sha256');
    obj.update(str + (slat ? slat : ''));
    return obj.digest('hex');
};

let dbLocker = {};
// interface ILocker {
//   [key: string]: string[];
// }
// export const setDbLocker = (locker: ILocker) => {
//   Object.keys(locker).forEach(key => {
//     dbLocker[key] = locker[key];
//   });
// };

const createRSA = () => {
    const RSA = {
        priateKey: null,
        publicKey: null,
        init: keyData => {
            let [a, b] = keyData.split('-----END PUBLIC KEY-----');
            a += `-----END PUBLIC KEY-----`;
            RSA.publicKey = new NodeRSA({ b: 512 });
            RSA.priateKey = new NodeRSA({ b: 512 });
            RSA.publicKey.importKey(a, 'public');
            RSA.priateKey.importKey(b, 'private');
            // RSA.key.setOptions({ encryptionScheme: 'pkcs1' });
        },
        createKeys: () => {
            const key = new NodeRSA({ b: 512 });
            let out = '';
            out += key.exportKey('public');
            out += key.exportKey('private');
            return out;
        },
        decode: (text) => {
            if (!RSA.publicKey) {
                return text;
            }
            return RSA.publicKey.decryptPublic(text, 'utf8');
        },
        encode: (text) => {
            if (typeof text !== 'string') {
                text = JSON.stringify(text);
            }
            if (!RSA.publicKey) {
                return text;
            }
            return RSA.priateKey.encryptPrivate(text, 'base64');
        },
    };
    return RSA;
};

const RSA = createRSA();

const canUseMethod = {
    insert: true,
    insertMany: true,
    insertOne: true,
    update: true,
    updateMany: true,
    updateOne: true,
    replaceOne: true,
    find: true,
    findOne: true,
};
const serverless = async (url = '/less', options) => {
    app.post(url, async (req, rep) => {
        if (!req.body || !req.body.code) {
            return rep.status(400).send(new Error('body or body.code is empty'));
        }
        const realData = JSON.parse(RSA.decode(req.body.code));
        if (options) {
            if (options.checkTime) {
                const nowTime = Date.now();
                if (realData._checkTime < nowTime - options.checkTime || realData._checkTime > nowTime + options.checkTime) {
                    return rep.status(400).send(new Error('client undefined error'));
                }
            }
            if (options.checkKey) {
                if (realData._checkKey !== options.checkKey) {
                    return rep.status(400).send(new Error('client undefined error'));
                }
            }
        }
        const body = realData.events ? realData.events : [realData];
        let nowEvent = 0;
        const recall = async () => {
            // 如果 event 溢出
            if (nowEvent > body.length - 1) {
                return rep.status(500).send(new Error('event is out'));
            }
            // 计算是否是最后一个
            let isNeedSend = false;
            if (nowEvent === body.length - 1) {
                isNeedSend = true;
            }
            let { db: dbName = 'test', col: colName = 'test', block, method, args = [], argsSha256, argsObjectId, trim, } = body[nowEvent];
            if (!canUseMethod[method]) {
                return rep.status(400).send(new Error(`can not use "${method}" method`));
            }
            const col = db(dbName).collection(colName);
            if (argsSha256) {
                argsSha256.forEach((p) => {
                    const value = lodash.get(args, p);
                    if (value) {
                        lodash.set(args, p, sha256(value));
                    }
                });
            }
            if (argsObjectId) {
                argsObjectId.forEach((id) => {
                    const value = lodash.get(args, id);
                    if (value) {
                        lodash.set(args, id, new mongodb.ObjectId(value));
                    }
                });
            }
            // 处理参数和限制权限
            if (method.indexOf('update') > -1 || method.indexOf('delete') > -1) {
                const filter = dbLocker[colName] && dbLocker[colName].filter;
                if (filter) {
                    let isLockerError = true;
                    for (let i = 0; i < filter.length; i++) {
                        const key = filter[i];
                        if (typeof key === 'string') {
                            const value = lodash.get(args[0], key);
                            if (value) {
                                isLockerError = false;
                                break;
                            }
                        }
                        else {
                            let isHaveValue = 0;
                            for (let j = 0; j < key.length; j++) {
                                const subKey = key[j];
                                const value = lodash.get(args[0], subKey);
                                if (value) {
                                    isHaveValue += 1;
                                }
                            }
                            if (isHaveValue === key.length) {
                                isLockerError = false;
                                break;
                            }
                        }
                    }
                    if (isLockerError) {
                        return rep.status(400).send(new Error(`locker: master filter use ${JSON.stringify(filter)}`));
                    }
                }
            }
            let data = await col[method](...args);
            if (method === 'find') {
                data = data.toArray();
            }
            if (block) {
                if (!data) {
                    return rep.status(400).send(new Error('block: data void'));
                }
                const keys = Object.keys(block);
                let blockError = null;
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    const value = block[key];
                    if (lodash.get(data, key) !== block[key]) {
                        blockError = new Error(`block: ${key} is not ${value}`);
                        break;
                    }
                }
                if (blockError) {
                    return rep.status(400).send(blockError);
                }
            }
            if (!isNeedSend) {
                nowEvent += 1;
                await recall();
                return;
            }
            if (!data) {
                return rep.status(200).send({ code: RSA.encode({ mes: 'data is empty' }) });
            }
            if (data) {
                const { connection, message, ...sendData } = data;
                // 提出不需要返回的
                const allTrim = new Set([...(trim || []), ...((dbLocker[colName] && dbLocker[colName].trim) || [])]);
                allTrim.forEach(key => {
                    lodash.set(sendData, key, undefined);
                });
                return rep.status(200).send({ code: RSA.encode(sendData) });
            }
        };
        await recall();
    });
};

const controllersLoader = (dir, indexOf, params) => {
    const files = fs.readdirSync(dir);
    files.forEach((file) => {
        const nextDir = path.resolve(dir, file);
        const stat = fs.statSync(nextDir);
        if (stat && stat.isDirectory()) {
            controllersLoader(nextDir, indexOf);
        }
        else if (file.indexOf(indexOf) > 0) {
            const ctrl = require(nextDir);
            if (typeof ctrl === 'function') {
                ctrl(params);
            }
        }
    });
};

exports.RSA = RSA;
exports.app = app;
exports.controllersLoader = controllersLoader;
exports.createRSA = createRSA;
exports.db = db;
exports.dbLocker = dbLocker;
exports.serverless = serverless;
exports.setCors = setCors;
exports.sha256 = sha256;
