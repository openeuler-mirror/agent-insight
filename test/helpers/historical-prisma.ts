import { PrismaClient } from '@prisma/client';
import path from 'node:path';
import { assertTemporaryHome } from './isolated-home';

let client: PrismaClient | undefined;

// Historical fixtures remain independent of the application's Core-only facade.
export const prismaRaw = new Proxy({} as PrismaClient, {
  get(_target, key) {
    if (!client) {
      const url = process.env.DATABASE_URL;
      if (!url?.startsWith('file:')) throw Error('Historical fixtures require an isolated SQLite file');
      assertTemporaryHome(path.dirname(url.slice(5)));
      client = new PrismaClient({ datasources: { db: { url } } });
    }
    const value = Reflect.get(client, key);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
export const prisma = prismaRaw;
