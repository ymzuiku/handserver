import fs from 'fs-extra';
import { resolve } from 'path';

export const controllersLoader = (dir: string, indexOf: string, params?: any) => {
  const files = fs.readdirSync(dir);
  files.forEach((file: string) => {
    const nextDir = resolve(dir, file);
    const stat = fs.statSync(nextDir);
    if (stat && stat.isDirectory()) {
      controllersLoader(nextDir, indexOf);
    } else if (file.indexOf(indexOf) > 0) {
      const ctrl = require(nextDir);
      if (typeof ctrl === 'function') {
        ctrl(params);
      }
    }
  });
};
