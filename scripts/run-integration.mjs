/** Creates and removes only its own disposable PostgreSQL databases on localhost. */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to an isolated local PostgreSQL server; this test never runs against production.');
}
const url = new URL(process.env.TEST_DATABASE_URL);
const requestedTests = process.argv.slice(2);
if (requestedTests.some((file) => !/^tests\/integration\/[a-z0-9-]+\.test\.js$/.test(file))) throw new Error('Pass integration test paths only.');
if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('TEST_DATABASE_URL must point to an isolated local PostgreSQL test server.');
// Each group gets its own fresh database: these suites open and close business
// days, so sharing one database makes them depend on each other's leftovers.
const groups = requestedTests.length ? [requestedTests] : [
  ['tests/integration/production.test.js', 'tests/integration/purchase-sales-analysis.test.js'],
  ['tests/integration/kot-bot.test.js'],
  ['tests/integration/print-helper.test.js'],
  ['tests/integration/kot-bot-reporting.test.js'],
];
const client = new pg.Client({connectionString:url.href});
await client.connect();
const failures = [];
try {
  for (const [index, files] of groups.entries()) {
    const name = `km_test_${Date.now()}_${process.pid}${index ? index : ''}`;
    let created=false;
    try {
      await client.query(`CREATE DATABASE "${name}"`); created=true;
      const target=new URL(url);target.pathname=`/${name}`;
      const env={...process.env,DATABASE_URL:target.href,ADMIN_PASSWORD:'KmTestOnly123',RESTAURANT_NAME:'Kathmandu Momo',SKIP_DB_ON_BUILD:''};
      const run=(args)=>{ const r=spawnSync(process.execPath,args,{env,stdio:'inherit'});if(r.status!==0)throw new Error(`Validation failed (${r.status}): ${args.join(' ')}`); };
      run(['scripts/migrate.mjs']);run(['scripts/seed-postgres.mjs']);
      run(['--import','./tests/unit/loader-register.mjs','--test',...files]);
    } catch (error) {
      failures.push(error);
    } finally {
      if(created)await client.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
  }
} finally {
  await client.end();
}
if (failures.length) throw failures[0];
