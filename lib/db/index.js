import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { isPostgresUrl, requirePostgresInProduction } from './sql.js';
import {
  pgAll,
  pgGet,
  pgRun,
  pgTransaction,
  getPool,
  closePool,
} from './postgres.js';
import { logger } from '../logger.js';
import os from 'os';
import { SQLITE_SCHEMA_DDL, seedDemoData } from './sqlite-seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

function normalizeParams(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

/**
 * SQLite backend — local/dev only. Not used when DATABASE_URL is set.
 * better-sqlite3 is loaded lazily so production Postgres installs need no native build.
 */
class SqlitePosDatabase {
  constructor(dbPath) {
    let BetterSqlite3;
    let isNodeSqlite = false;
    try {
      BetterSqlite3 = require('better-sqlite3');
    } catch {
      try {
        BetterSqlite3 = require('node:sqlite').DatabaseSync;
        isNodeSqlite = true;
      } catch (err) {
        throw new Error(
          'Neither better-sqlite3 nor node:sqlite is available. For production use DATABASE_URL (PostgreSQL).'
        );
      }
    }

    if (!dbPath) {
      if (process.env.VERCEL === '1') {
        dbPath = path.join(os.tmpdir(), 'pos_restaurant.db');
      } else {
        if (process.env.DB_NAME) {
          dbPath = `databases/${process.env.DB_NAME}`;
        }
        const licensePath = path.join(process.cwd(), 'databases', '.license');
        if (!dbPath && fs.existsSync(licensePath)) {
          try {
            const licenseData = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
            dbPath = `databases/${licenseData.db_name}`;
          } catch (error) {
            logger.warn('license_read_failed', { message: error.message });
          }
        }
        if (!dbPath) dbPath = 'pos_restaurant.db';
      }
    }

    const fullPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const dbExists = fs.existsSync(fullPath);
    logger.info('sqlite_open', { path: path.basename(fullPath), driver: isNodeSqlite ? 'node:sqlite' : 'better-sqlite3' });

    this.driver = 'sqlite';
    this.isNodeSqlite = isNodeSqlite;
    
    if (isNodeSqlite) {
      this.db = new BetterSqlite3(fullPath);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA foreign_keys = ON');
    } else {
      this.db = new BetterSqlite3(fullPath, {
        verbose: process.env.DEBUG_SQL === '1' ? (msg) => logger.debug('sql', { msg }) : null,
      });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    }

    // Auto-init schema and seed demo data if users table doesn't exist
    let usersExist = false;
    try {
      const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
      if (row) usersExist = true;
    } catch (e) {
      // Table doesn't exist
    }

    if (!usersExist) {
      logger.info('sqlite_initializing_schema_and_seeding');
      try {
        this.db.exec(SQLITE_SCHEMA_DDL);
        seedDemoData(this.db);
        logger.info('sqlite_initializing_complete');
      } catch (err) {
        logger.error('sqlite_initializing_failed', { message: err.message, stack: err.stack });
      }
    } else {
      this.ensureKitchenTables();
    }
  }

  ensureKitchenTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kot_number TEXT,
        order_id INTEGER NOT NULL,
        station TEXT DEFAULT 'main',
        status TEXT DEFAULT 'pending',
        prepared_by INTEGER,
        printed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kot_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kot_id INTEGER NOT NULL,
        order_item_id INTEGER,
        menu_item_id INTEGER,
        quantity INTEGER NOT NULL DEFAULT 1,
        special_instructions TEXT,
        status TEXT DEFAULT 'pending',
        FOREIGN KEY (kot_id) REFERENCES kots(id) ON DELETE CASCADE
      );
    `);
  }

  async run(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const p = Array.isArray(params) ? params : [params];
    return this.isNodeSqlite ? stmt.run(...p) : stmt.run(p);
  }

  async get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const p = Array.isArray(params) ? params : [params];
    return this.isNodeSqlite ? stmt.get(...p) : stmt.get(p);
  }

  async all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const p = Array.isArray(params) ? params : [params];
    return this.isNodeSqlite ? stmt.all(...p) : stmt.all(p);
  }

  async transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  prepare(sql) {
    const stmt = this.db.prepare(sql);
    const isNode = this.isNodeSqlite;
    return {
      all: async (...args) => {
        const p = normalizeParams(args);
        return isNode ? stmt.all(...p) : stmt.all(p);
      },
      get: async (...args) => {
        const p = normalizeParams(args);
        return isNode ? stmt.get(...p) : stmt.get(p);
      },
      run: async (...args) => {
        const p = normalizeParams(args);
        return isNode ? stmt.run(...p) : stmt.run(p);
      },
    };
  }

  close() {
    if (this.db && typeof this.db.close === 'function') {
      this.db.close();
    }
  }
}

class PostgresPosDatabase {
  constructor() {
    this.driver = 'postgres';
    this.pool = getPool();
    this.db = {
      prepare: (sql) => this.prepare(sql),
    };
    logger.info('postgres_open', { poolMax: process.env.PG_POOL_MAX || '5' });
  }

  prepare(sql) {
    return {
      all: async (...args) => pgAll(sql, normalizeParams(args)),
      get: async (...args) => pgGet(sql, normalizeParams(args)),
      run: async (...args) => pgRun(sql, normalizeParams(args)),
    };
  }

  async run(sql, params = []) {
    return pgRun(sql, params);
  }

  async get(sql, params = []) {
    return pgGet(sql, params);
  }

  async all(sql, params = []) {
    return pgAll(sql, params);
  }

  async transaction(fn) {
    return pgTransaction(async (tx) => fn(tx));
  }

  async close() {
    await closePool();
  }
}

function createDatabase() {
  requirePostgresInProduction();
  if (isPostgresUrl()) {
    return new PostgresPosDatabase();
  }
  // During production build without DATABASE_URL, return a stub that fails on use
  if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.SKIP_DB_ON_BUILD === '1') {
    return {
      driver: 'build-stub',
      async run() {
        throw new Error('Database unavailable during build');
      },
      async get() {
        throw new Error('Database unavailable during build');
      },
      async all() {
        throw new Error('Database unavailable during build');
      },
      async transaction() {
        throw new Error('Database unavailable during build');
      },
      prepare() {
        throw new Error('Database unavailable during build');
      },
      close() {},
    };
  }
  return new SqlitePosDatabase();
}

class Database {
  static instance = null;

  static getInstance() {
    if (!Database.instance) {
      Database.instance = createDatabase();
    }
    return Database.instance;
  }

  static isPostgres() {
    return isPostgresUrl();
  }

  static async close() {
    if (Database.instance?.close) {
      await Database.instance.close();
    }
    Database.instance = null;
  }
}

export { SqlitePosDatabase as PosDatabase };
export default Database;
