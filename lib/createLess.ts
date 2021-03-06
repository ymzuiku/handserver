import { db } from './db';
import { ObjectId, Collection } from 'mongodb';
import { set, get } from 'lodash';
import { sha256 } from './sha256';
import { app } from './app';

interface IReducerBack {
  error: any;
  nextData: any;
}

interface IBodyData {
  db?: string;
  col?: string;
  block?: { [name: string]: any };
  method: string;
  args?: any[];
  // 用来标记需要转化为 sha256 的args路径
  argsSha256?: string[];
  // 用来标记需要转化为 ObjectId 的args路径
  argsObjectId?: string[];
  remove?: string[];
  [other: string]: any;
}

const canUseMethod = new Set([
  'insert',
  'insertMany',
  'insertOne',
  'deleteOne',
  'update',
  'updateMany',
  'updateOne',
  'replaceOne',
  'find',
  'findOne',
]);

export interface ILessOptions {
  url?: string;
  useWss?: boolean;
  onlyOpenDb?: Set<string>;
  onlyOpenCol?: Set<string>;
  reducer?: { [dbAndCol: string]: (data: IBodyData, col: Collection<any>) => IReducerBack };
}

function getByDbAndCol(obj: any, dbName: string, colName: string) {
  if (obj[`${dbName}:*`]) {
    return obj[`${dbName}:*`];
  } else if (obj[`*:${colName}`]) {
    return obj[`*:${colName}`];
  } else if (obj[`${dbName}:${colName}`]) {
    return obj[`${dbName}:${colName}`];
  }
  return null;
}

export const createLess = async (options: ILessOptions) => {
  const { reducer = {}, onlyOpenCol, onlyOpenDb } = options;

  // 请求事件
  async function event(reqBody: any) {
    let out: any = { error: 'recall no run' };

    if (!reqBody) {
      return (out = { error: 'body or body.code is empty' });
    }

    const body: IBodyData[] = reqBody.events ? reqBody.events : [reqBody];

    let eventNumber = 0;

    const recall = async () => {
      // 如果 event 溢出
      if (eventNumber > body.length - 1) {
        return (out = { error: 'event is out' });
      }

      // 计算是否是最后一个
      let isNeedSend = false;
      if (eventNumber === body.length - 1) {
        isNeedSend = true;
      }

      let {
        db: dbName = 'test',
        col: colName = 'test',
        block,
        method,
        args = [],
        argsSha256,
        argsObjectId,
        remove,
      } = body[eventNumber];

      dbName = dbName.trim();
      colName = colName.trim();

      if (onlyOpenDb && !onlyOpenDb.has(dbName)) {
        return (out = { error: `permission[db]: ${dbName} is private` });
      }

      if (onlyOpenCol && !onlyOpenCol.has(colName)) {
        return (out = { error: `permission[col]: ${colName} is private` });
      }

      if (!canUseMethod.has(method)) {
        return (out = { error: `can not use "${method}" method` });
      }

      // 处理argsSha256
      if (argsSha256) {
        if (!argsSha256.forEach) {
          return (out = { error: 'argsSha256 is no array' });
        }
        argsSha256.forEach((p: string) => {
          const value = get(args, p);

          if (value) {
            set(args, p, sha256(value));
          }
        });
      }

      if (argsObjectId) {
        if (!argsObjectId.forEach) {
          return (out = { error: 'argsObjectId is no array' });
        }
        argsObjectId.forEach((id: string) => {
          const value = get(args, id);

          if (value) {
            set(args, id, new ObjectId(value));
          }
        });
      }

      const col = db(dbName).collection(colName);

      const reducerEvent = getByDbAndCol(reducer, dbName, colName);

      if (reducerEvent) {
        const reducerBack = await reducerEvent(
          {
            db: dbName,
            col: colName,
            block,
            method,
            args,
            argsSha256,
            argsObjectId,
            remove,
          },
          col,
        );

        if (reducerBack) {
          if (reducerBack.error) {
            reducerBack.isReducer = true;
            return (out = reducerBack);
          }
          if (reducerBack.nextData) {
            dbName = reducerBack.nextData.db;
            colName = reducerBack.nextData.col;
            block = reducerBack.nextData.block;
            method = reducerBack.nextData.method;
            args = reducerBack.nextData.args;
            argsSha256 = reducerBack.nextData.argsSha256;
            argsObjectId = reducerBack.nextData.argsObjectId;
          }
        }
      }

      let response;

      try {
        if (method === 'find') {
          response = await (col as any)[method](...args).toArray();
        } else {
          response = await (col as any)[method](...args);
        }
      } catch (err) {
        app.log.error(err);
        return (out = { error: 'database method error', msg: err, info: { dbName, colName, method } });
      }

      if (block) {
        if (!response) {
          return (out = { error: 'data is empty', empty: true });
        }
        if (method === 'find' && response.length === 0) {
          return (out = { error: 'block: not find' });
        }
        if (response.result && !response.result.n) {
          const { connection, message, ...sendData } = response;

          // 剔除不需要返回的
          const allTrim = new Set([...(remove || [])]);

          allTrim.forEach(key => {
            set(sendData, key, undefined);
          });
          return (out = { error: 'block: data result.n is 0', res: sendData });
        }
      }

      if (!isNeedSend) {
        eventNumber += 1;
        await recall();

        return;
      }

      if (!response) {
        out = { msg: 'data is empty', empty: true };
        return;
      }
      if (response) {
        const { connection, message, ...sendData } = response;

        // 剔除不需要返回的
        const allTrim = new Set([...(remove || [])]);

        allTrim.forEach(key => {
          set(sendData, key, undefined);
        });

        if (method === 'find') {
          out = { list: response };
          return;
        }

        out = sendData;
        return;
      }
    };

    await recall();

    return out;
  }

  return event;
};
