/**
 * Integration tests for cassandra-guard against a real Cassandra instance.
 *
 * Environment variables:
 *   CASSANDRA_HOST       — default: 127.0.0.1
 *   CASSANDRA_PORT       — default: 9042
 *   CASSANDRA_DATACENTER — default: datacenter1
 *
 * If Cassandra is not reachable the entire suite is skipped gracefully.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { SchemaRegistry } = require('../src/SchemaRegistry');
const { CQLBuilder, CQLFunction, VERSION_FEATURES, versionAtLeast } = require('../src/CQLBuilder');
const { DDLGenerator } = require('../src/DDLGenerator');
const { MigrationDiffer } = require('../src/MigrationDiffer');
const { LiveSchemaIntrospector } = require('../src/LiveSchemaIntrospector');
const { CompatibilityChecker } = require('../src/CompatibilityChecker');

// ── Connection config ────────────────────────────────────────────────────────

const CONTACT_POINT = process.env.CASSANDRA_HOST || '127.0.0.1';
const PORT = parseInt(process.env.CASSANDRA_PORT || '9042', 10);
const LOCAL_DC = process.env.CASSANDRA_DATACENTER || 'datacenter1';
const TEST_KEYSPACE = 'csg_integration_test';

// ── Test schema (SimpleStrategy RF=1 so it works on a single-node CI cluster) ─

const testSchema = {
  keyspace: TEST_KEYSPACE,
  replication: { class: 'SimpleStrategy', replication_factor: 1 },
  durable_writes: true,
  types: {
    address: {
      fields: {
        street: 'text',
        city: 'text',
        state: 'text',
        zip: 'text',
        country: 'text',
      },
    },
  },
  tables: {
    users: {
      columns: {
        user_id: 'uuid',
        email: 'text',
        name: 'text',
        address: 'address',
        created_at: 'timestamp',
        updated_at: 'timestamp',
        tags: 'set<text>',
        preferences: 'map<text, text>',
      },
      partition_key: ['user_id'],
      clustering_key: [],
      indexes: ['email'],
    },
    orders_by_user: {
      columns: {
        user_id: 'uuid',
        order_id: 'timeuuid',
        status: 'text',
        total_cents: 'bigint',
        items: 'list<text>',
        created_at: 'timestamp',
      },
      partition_key: ['user_id'],
      clustering_key: [{ column: 'order_id', order: 'DESC' }],
      options: {
        default_time_to_live: 0,
        gc_grace_seconds: 864000,
      },
    },
    products: {
      columns: {
        product_id: 'uuid',
        name: 'text',
        description: 'text',
        price_cents: 'bigint',
        category: 'text',
        in_stock: 'boolean',
      },
      partition_key: ['product_id'],
      clustering_key: [],
      indexes: ['category'],
    },
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

let client;
let cassandra;

async function connectOrSkip() {
  try {
    cassandra = require('cassandra-driver');
  } catch {
    return null;
  }

  const c = new cassandra.Client({
    contactPoints: [CONTACT_POINT],
    localDataCenter: LOCAL_DC,
    protocolOptions: { port: PORT },
    socketOptions: { connectTimeout: 5000, readTimeout: 12000 },
  });

  try {
    await c.connect();
    return c;
  } catch {
    return null;
  }
}

async function dropTestKeyspace() {
  try {
    await client.execute(`DROP KEYSPACE IF EXISTS ${TEST_KEYSPACE}`);
  } catch {
    // best-effort
  }
}

/**
 * Guard that skips the test if Cassandra is not connected.
 * Call at the top of every `it()` callback: `if (skipIfNoDb(t)) return;`
 */
function skipIfNoDb(t) {
  if (!client) {
    t.skip('Cassandra not reachable');
    return true;
  }
  return false;
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('Integration — real Cassandra', { timeout: 120_000 }, () => {
  let registry;
  let cql;
  let ddlGen;
  let userId;

  before(async () => {
    client = await connectOrSkip();
    if (!client) {
      console.log('Cassandra not reachable — skipping integration tests');
      return;
    }
    // Start clean
    await dropTestKeyspace();

    // Generate a UUID for CRUD tests (must happen after cassandra-driver is loaded)
    userId = cassandra.types.Uuid.random();

    // Register schema
    registry = new SchemaRegistry();
    registry.register(testSchema);
    cql = new CQLBuilder(registry);
    ddlGen = new DDLGenerator(registry);
  });

  after(async () => {
    if (client) {
      await dropTestKeyspace();
      await client.shutdown();
    }
  });

  // ── DDL Execution ────────────────────────────────────────────────────────

  describe('DDL Execution', () => {
    it('creates keyspace, types, and tables from generated DDL', async (t) => {
      if (skipIfNoDb(t)) return;

      const statements = ddlGen.generateKeyspace(TEST_KEYSPACE);
      assert.ok(statements.length > 0, 'DDL should produce statements');

      for (const stmt of statements) {
        await client.execute(stmt);
      }

      // Verify keyspace exists
      const ksResult = await client.execute(
        'SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = ?',
        [TEST_KEYSPACE],
        { prepare: true }
      );
      assert.equal(ksResult.rows.length, 1, 'Keyspace should exist');

      // Verify tables exist
      const tableResult = await client.execute(
        'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?',
        [TEST_KEYSPACE],
        { prepare: true }
      );
      const tableNames = tableResult.rows.map(r => r.table_name).sort();
      assert.deepEqual(tableNames, ['orders_by_user', 'products', 'users']);

      // Verify UDT exists
      const udtResult = await client.execute(
        'SELECT type_name FROM system_schema.types WHERE keyspace_name = ?',
        [TEST_KEYSPACE],
        { prepare: true }
      );
      assert.equal(udtResult.rows.length, 1);
      assert.equal(udtResult.rows[0].type_name, 'address');
    });
  });

  // ── CQL Builder CRUD ──────────────────────────────────────────────────────

  describe('CQL Builder CRUD', () => {
    it('INSERTs a row via CQLBuilder', async (t) => {
      if (skipIfNoDb(t)) return;

      const { cql: insertCql, params } = cql.insert(TEST_KEYSPACE, 'users')
        .values({
          user_id: userId,
          email: 'integration@test.com',
          name: 'Integration User',
          tags: ['beta', 'tester'],
          preferences: { theme: 'dark' },
        })
        .build();

      await client.execute(insertCql, params, { prepare: true });

      // Verify the row
      const result = await client.execute(
        `SELECT * FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [userId],
        { prepare: true }
      );
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].email, 'integration@test.com');
      assert.equal(result.rows[0].name, 'Integration User');
    });

    it('SELECTs the inserted row via CQLBuilder', async (t) => {
      if (skipIfNoDb(t)) return;

      const { cql: selectCql, params } = cql.select(TEST_KEYSPACE, 'users')
        .columns('user_id', 'email', 'name')
        .where('user_id', userId)
        .build();

      const result = await client.execute(selectCql, params, { prepare: true });
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].email, 'integration@test.com');
    });

    it('UPDATEs a row via CQLBuilder', async (t) => {
      if (skipIfNoDb(t)) return;

      const { cql: updateCql, params } = cql.update(TEST_KEYSPACE, 'users')
        .set('name', 'Updated User')
        .where('user_id', userId)
        .build();

      await client.execute(updateCql, params, { prepare: true });

      const result = await client.execute(
        `SELECT name FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [userId],
        { prepare: true }
      );
      assert.equal(result.rows[0].name, 'Updated User');
    });

    it('UPDATEs a set collection via addToSet', async (t) => {
      if (skipIfNoDb(t)) return;

      const { cql: updateCql, params } = cql.update(TEST_KEYSPACE, 'users')
        .addToSet('tags', ['premium'])
        .where('user_id', userId)
        .build();

      await client.execute(updateCql, params, { prepare: true });

      const result = await client.execute(
        `SELECT tags FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [userId],
        { prepare: true }
      );
      const tags = result.rows[0].tags;
      // cassandra-driver returns sets as arrays
      assert.ok(Array.isArray(tags) ? tags.includes('beta') : tags.has('beta'));
      assert.ok(Array.isArray(tags) ? tags.includes('tester') : tags.has('tester'));
      assert.ok(Array.isArray(tags) ? tags.includes('premium') : tags.has('premium'));
    });

    it('UPDATEs a map collection via putToMap', async (t) => {
      if (skipIfNoDb(t)) return;

      const { cql: updateCql, params } = cql.update(TEST_KEYSPACE, 'users')
        .putToMap('preferences', 'lang', 'en')
        .where('user_id', userId)
        .build();

      await client.execute(updateCql, params, { prepare: true });

      const result = await client.execute(
        `SELECT preferences FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [userId],
        { prepare: true }
      );
      const prefs = result.rows[0].preferences;
      // cassandra-driver returns maps as plain objects
      assert.equal(prefs.theme || prefs.get?.('theme'), 'dark');
      assert.equal(prefs.lang || prefs.get?.('lang'), 'en');
    });

    it('DELETEs a row via CQLBuilder', async (t) => {
      if (skipIfNoDb(t)) return;

      const { cql: deleteCql, params } = cql.delete(TEST_KEYSPACE, 'users')
        .where('user_id', userId)
        .build();

      await client.execute(deleteCql, params, { prepare: true });

      const result = await client.execute(
        `SELECT * FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [userId],
        { prepare: true }
      );
      assert.equal(result.rows.length, 0);
    });
  });

  // ── Batch Operations ───────────────────────────────────────────────────────

  describe('Batch Operations', () => {
    it('executes a batched insert of multiple products', async (t) => {
      if (skipIfNoDb(t)) return;

      const ids = Array.from({ length: 3 }, () => cassandra.types.Uuid.random());

      const batch = cql.batch('LOGGED');
      for (let i = 0; i < ids.length; i++) {
        batch.add(
          cql.insert(TEST_KEYSPACE, 'products').values({
            product_id: ids[i],
            name: `Product ${i}`,
            description: `Description ${i}`,
            price_cents: (i + 1) * 1000,
            category: 'test-category',
            in_stock: true,
          })
        );
      }

      const { cql: batchCql, params } = batch.build();
      await client.execute(batchCql, params, { prepare: true });

      // Verify all rows
      for (const id of ids) {
        const result = await client.execute(
          `SELECT * FROM ${TEST_KEYSPACE}.products WHERE product_id = ?`,
          [id],
          { prepare: true }
        );
        assert.equal(result.rows.length, 1);
      }
    });
  });

  // ── LiveSchemaIntrospector ─────────────────────────────────────────────────

  describe('LiveSchemaIntrospector', () => {
    it('introspects the keyspace and returns a valid schema', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      assert.equal(liveSchema.keyspace, TEST_KEYSPACE);

      // Should have all our tables
      const liveTableNames = Object.keys(liveSchema.tables).sort();
      assert.deepEqual(liveTableNames, ['orders_by_user', 'products', 'users']);

      // Verify users table columns exist
      const usersCols = Object.keys(liveSchema.tables.users.columns).sort();
      assert.ok(usersCols.includes('user_id'));
      assert.ok(usersCols.includes('email'));
      assert.ok(usersCols.includes('name'));
      assert.ok(usersCols.includes('tags'));
      assert.ok(usersCols.includes('preferences'));

      // Verify partition key
      assert.deepEqual(liveSchema.tables.users.partition_key, ['user_id']);

      // Verify clustering key on orders_by_user
      const ordersCK = liveSchema.tables.orders_by_user.clustering_key;
      assert.equal(ordersCK.length, 1);
      assert.equal(ordersCK[0].column, 'order_id');
      assert.equal(ordersCK[0].order, 'DESC');

      // Verify UDT
      assert.ok(liveSchema.types.address);
      assert.ok(liveSchema.types.address.fields.street);
    });

    it('throws on a nonexistent keyspace', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      await assert.rejects(
        () => introspector.introspect('totally_fake_keyspace_xyz'),
        /does not exist/
      );
    });
  });

  // ── Migration Differ round-trip ────────────────────────────────────────────

  describe('Migration Differ round-trip', () => {
    it('diffs live schema vs. modified schema and applies migration', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      // Build a "new" schema that adds a column to `users` and a new table
      const newSchema = JSON.parse(JSON.stringify(testSchema));
      newSchema.tables.users.columns.phone = 'text';
      newSchema.tables.audit_log = {
        columns: {
          event_id: 'uuid',
          event_type: 'text',
          payload: 'text',
          created_at: 'timestamp',
        },
        partition_key: ['event_id'],
        clustering_key: [],
      };

      // Register and normalize the new schema
      const newRegistry = new SchemaRegistry();
      newRegistry.register(newSchema);
      const normalizedNew = newRegistry.get(TEST_KEYSPACE);

      // Diff
      const differ = new MigrationDiffer();
      const result = differ.diff(liveSchema, normalizedNew);

      assert.ok(result.statements.length > 0, 'Should have migration statements');

      // Should include ALTER TABLE ... ADD phone and CREATE TABLE ... audit_log
      const hasAddPhone = result.statements.some(s =>
        s.includes('ADD phone') && s.includes('users')
      );
      const hasCreateAudit = result.statements.some(s =>
        s.includes('CREATE TABLE') && s.includes('audit_log')
      );
      assert.ok(hasAddPhone, 'Migration should add phone column');
      assert.ok(hasCreateAudit, 'Migration should create audit_log table');

      // Apply migration
      for (const stmt of result.statements) {
        await client.execute(stmt);
      }

      // Re-introspect and verify
      const updatedSchema = await introspector.introspect(TEST_KEYSPACE);
      assert.ok('phone' in updatedSchema.tables.users.columns, 'phone column should exist after migration');
      assert.ok('audit_log' in updatedSchema.tables, 'audit_log table should exist after migration');

      // Diff again — should be in sync now
      const newRegistry2 = new SchemaRegistry();
      newRegistry2.register(newSchema);
      const normalizedNew2 = newRegistry2.get(TEST_KEYSPACE);
      const result2 = differ.diff(updatedSchema, normalizedNew2);
      // Filter out index-related and table-option statements since introspection may
      // return indexes in a different format and omit default option values (e.g.
      // default_time_to_live = 0 is not returned by Cassandra since it's the default)
      const nonTrivialStmts = result2.statements.filter(s =>
        !s.includes('CREATE INDEX') &&
        !s.includes('DROP INDEX') &&
        !s.includes('default_time_to_live = 0')
      );
      assert.equal(nonTrivialStmts.length, 0, 'Schema should be in sync after applying migration (ignoring index/option format diffs)');
    });
  });

  // ── TTL=0 (USING TTL 0 clears TTL) ──────────────────────────────────────────

  describe('TTL=0 support', () => {
    it('INSERTs with TTL then clears it with TTL=0 UPDATE', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();

      // Insert with TTL 600
      const { cql: insCql, params: insParams } = cql.insert(TEST_KEYSPACE, 'users')
        .values({ user_id: id, email: 'ttl-test@test.com', name: 'TTL User' })
        .ttl(600)
        .build();
      await client.execute(insCql, insParams, { prepare: true });

      // Verify TTL is set (> 0)
      const ttlResult1 = await client.execute(
        `SELECT TTL(email) AS email_ttl FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [id], { prepare: true }
      );
      assert.ok(ttlResult1.rows[0].email_ttl > 0, 'TTL should be set after INSERT with TTL');

      // Clear TTL using UPDATE with TTL 0
      const { cql: updCql, params: updParams } = cql.update(TEST_KEYSPACE, 'users')
        .set('email', 'ttl-test@test.com')
        .where('user_id', id)
        .ttl(0)
        .build();
      await client.execute(updCql, updParams, { prepare: true });

      // Verify TTL is cleared (null = no TTL)
      const ttlResult2 = await client.execute(
        `SELECT TTL(email) AS email_ttl FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [id], { prepare: true }
      );
      assert.equal(ttlResult2.rows[0].email_ttl, null, 'TTL should be null after UPDATE with TTL 0');

      // Cleanup
      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });

    it('INSERTs with TTL=0 (no expiry)', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();

      const { cql: insCql, params } = cql.insert(TEST_KEYSPACE, 'users')
        .values({ user_id: id, email: 'ttl0@test.com', name: 'No Expiry' })
        .ttl(0)
        .build();
      await client.execute(insCql, params, { prepare: true });

      // Verify row exists with no TTL
      const result = await client.execute(
        `SELECT email, TTL(email) AS email_ttl FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [id], { prepare: true }
      );
      assert.equal(result.rows[0].email, 'ttl0@test.com');
      assert.equal(result.rows[0].email_ttl, null, 'TTL should be null for TTL=0 insert');

      // Cleanup
      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });
  });

  // ── UDT setField ─────────────────────────────────────────────────────

  describe('UDT setField', () => {
    it('inserts a row with UDT then updates individual fields', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();

      // Insert with full UDT value
      const { cql: insCql, params: insParams } = cql.insert(TEST_KEYSPACE, 'users')
        .values({
          user_id: id,
          email: 'udt@test.com',
          name: 'UDT User',
          address: { street: '100 Main St', city: 'Boston', state: 'MA', zip: '02101', country: 'US' },
        })
        .build();
      await client.execute(insCql, insParams, { prepare: true });

      // Update a single UDT field
      const { cql: updCql, params: updParams } = cql.update(TEST_KEYSPACE, 'users')
        .setField('address', 'city', 'New York')
        .setField('address', 'zip', '10001')
        .where('user_id', id)
        .build();
      await client.execute(updCql, updParams, { prepare: true });

      // Verify
      const result = await client.execute(
        `SELECT address FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [id], { prepare: true }
      );
      const addr = result.rows[0].address;
      assert.equal(addr.city, 'New York', 'city should be updated');
      assert.equal(addr.zip, '10001', 'zip should be updated');
      assert.equal(addr.street, '100 Main St', 'street should be unchanged');
      assert.equal(addr.state, 'MA', 'state should be unchanged');

      // Cleanup
      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });

    it('mixes setField with regular set', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();

      // Insert
      const { cql: insCql, params: insParams } = cql.insert(TEST_KEYSPACE, 'users')
        .values({
          user_id: id,
          email: 'mix@test.com',
          name: 'Mix User',
          address: { street: '200 Oak Ave', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
        })
        .build();
      await client.execute(insCql, insParams, { prepare: true });

      // Update both regular column and UDT field
      const { cql: updCql, params: updParams } = cql.update(TEST_KEYSPACE, 'users')
        .set('name', 'Updated Mix User')
        .setField('address', 'city', 'Detroit')
        .where('user_id', id)
        .build();
      await client.execute(updCql, updParams, { prepare: true });

      // Verify
      const result = await client.execute(
        `SELECT name, address FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [id], { prepare: true }
      );
      assert.equal(result.rows[0].name, 'Updated Mix User');
      assert.equal(result.rows[0].address.city, 'Detroit');
      assert.equal(result.rows[0].address.street, '200 Oak Ave', 'unchanged fields preserved');

      // Cleanup
      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });

    it('rejects setField on a frozen UDT column before hitting Cassandra', async (t) => {
      if (skipIfNoDb(t)) return;

      // Register a separate schema where address is frozen
      const frozenRegistry = new SchemaRegistry();
      frozenRegistry.register({
        ...testSchema,
        keyspace: TEST_KEYSPACE,
        tables: {
          ...testSchema.tables,
          users: {
            ...testSchema.tables.users,
            columns: {
              ...testSchema.tables.users.columns,
              address: 'frozen<address>',  // frozen — subfield updates are invalid
            },
          },
        },
      });
      const frozenCql = new CQLBuilder(frozenRegistry);

      // setField must throw at build time, never sending a query to Cassandra
      assert.throws(
        () => frozenCql.update(TEST_KEYSPACE, 'users')
          .setField('address', 'city', 'NYC')
          .where('user_id', cassandra.types.Uuid.random())
          .build(),
        /frozen UDT/
      );
    });
  });

  // ── CQLFunction (server-side functions) ─────────────────────────────

  describe('CQLFunction — server-side functions', () => {
    it('INSERTs with now() for timeuuid and toTimestamp(now()) for timestamp', async (t) => {
      if (skipIfNoDb(t)) return;

      const uid = cassandra.types.Uuid.random();

      // Insert an order using server-side now() for the timeuuid order_id
      // and toTimestamp(now()) for the created_at timestamp
      const { cql: insCql, params } = cql.insert(TEST_KEYSPACE, 'orders_by_user')
        .values({
          user_id: uid,
          order_id: CQLBuilder.fn('now'),
          status: 'pending',
          total_cents: 4999,
          created_at: CQLBuilder.fn('toTimestamp', CQLBuilder.fn('now')),
        })
        .build();

      // Verify the CQL uses function calls, not parameterized values
      assert.match(insCql, /now\(\)/);
      assert.match(insCql, /toTimestamp\(now\(\)\)/);
      // Only 3 params (user_id, status, total_cents) — not 5
      assert.equal(params.length, 3);

      await client.execute(insCql, params, { prepare: true });

      // Verify the row was inserted with server-generated values
      const result = await client.execute(
        `SELECT order_id, created_at, status FROM ${TEST_KEYSPACE}.orders_by_user WHERE user_id = ?`,
        [uid], { prepare: true }
      );
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].status, 'pending');
      // order_id should be a valid TimeUuid generated by the server
      assert.ok(result.rows[0].order_id, 'order_id should be set by now()');
      // created_at should be a valid Date
      assert.ok(result.rows[0].created_at instanceof Date, 'created_at should be a Date from toTimestamp(now())');

      // Cleanup
      await client.execute(
        `DELETE FROM ${TEST_KEYSPACE}.orders_by_user WHERE user_id = ? AND order_id = ?`,
        [uid, result.rows[0].order_id], { prepare: true }
      );
    });

    it('UPDATEs with toTimestamp(now()) for updated_at', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();

      // Insert without timestamp
      const { cql: insCql, params: insParams } = cql.insert(TEST_KEYSPACE, 'users')
        .values({ user_id: id, email: 'fn-upd@test.com', name: 'Fn Update User' })
        .build();
      await client.execute(insCql, insParams, { prepare: true });

      // Update using server-side function
      const { cql: updCql, params: updParams } = cql.update(TEST_KEYSPACE, 'users')
        .set('name', 'Updated Fn User')
        .set('updated_at', CQLBuilder.fn('toTimestamp', CQLBuilder.fn('now')))
        .where('user_id', id)
        .build();

      assert.match(updCql, /updated_at = toTimestamp\(now\(\)\)/);
      // Only 2 params: name value + where value (updated_at is a function, not a param)
      assert.equal(updParams.length, 2);

      await client.execute(updCql, updParams, { prepare: true });

      // Verify
      const result = await client.execute(
        `SELECT name, updated_at FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [id], { prepare: true }
      );
      assert.equal(result.rows[0].name, 'Updated Fn User');
      assert.ok(result.rows[0].updated_at instanceof Date, 'updated_at should be set by server-side function');

      // Cleanup
      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });

    it('uses uuid() to generate a primary key in INSERT', async (t) => {
      if (skipIfNoDb(t)) return;

      const { cql: insCql, params } = cql.insert(TEST_KEYSPACE, 'products')
        .values({
          product_id: CQLBuilder.fn('uuid'),
          name: 'Server UUID Product',
          description: 'Generated with uuid()',
          price_cents: 1500,
          category: 'fn-test',
          in_stock: true,
        })
        .build();

      assert.match(insCql, /uuid\(\)/);
      // product_id is a function, so only 5 params
      assert.equal(params.length, 5);

      await client.execute(insCql, params, { prepare: true });

      // Verify by querying the category index
      const result = await client.execute(
        `SELECT product_id, name FROM ${TEST_KEYSPACE}.products WHERE category = ?`,
        ['fn-test'], { prepare: true }
      );
      assert.ok(result.rows.length >= 1);
      const row = result.rows.find(r => r.name === 'Server UUID Product');
      assert.ok(row, 'Should find the product inserted with uuid()');
      assert.ok(row.product_id, 'product_id should be set by server-side uuid()');

      // Cleanup
      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.products WHERE product_id = ?`, [row.product_id], { prepare: true });
    });
  });

  // ── Schema cross-validation (UDT references) ─────────────────────────────

  describe('Schema cross-validation — UDT references', () => {
    it('rejects schema with undefined UDT before hitting Cassandra', (t) => {
      if (skipIfNoDb(t)) return;

      const badRegistry = new SchemaRegistry();
      assert.throws(
        () => badRegistry.register({
          keyspace: 'bad_ks',
          replication: { class: 'SimpleStrategy', replication_factor: 1 },
          tables: {
            things: {
              columns: {
                id: 'uuid',
                location: 'frozen<geo_point>',  // geo_point is not defined
              },
              partition_key: ['id'],
            },
          },
        }),
        (err) => {
          assert.ok(err.message.includes('undefined type "geo_point"'));
          return true;
        }
      );
    });

    it('rejects schema with undefined UDT inside a collection type', (t) => {
      if (skipIfNoDb(t)) return;

      const badRegistry = new SchemaRegistry();
      assert.throws(
        () => badRegistry.register({
          keyspace: 'bad_ks2',
          replication: { class: 'SimpleStrategy', replication_factor: 1 },
          tables: {
            things: {
              columns: {
                id: 'uuid',
                addresses: 'list<frozen<address>>',  // address is not defined
              },
              partition_key: ['id'],
            },
          },
        }),
        (err) => {
          assert.ok(err.message.includes('undefined type "address"'));
          return true;
        }
      );
    });

    it('rejects schema where UDT field references another undefined UDT', (t) => {
      if (skipIfNoDb(t)) return;

      const badRegistry = new SchemaRegistry();
      assert.throws(
        () => badRegistry.register({
          keyspace: 'bad_ks3',
          replication: { class: 'SimpleStrategy', replication_factor: 1 },
          types: {
            order_info: {
              fields: {
                total: 'int',
                shipping_addr: 'frozen<address>',  // address is not defined
              },
            },
          },
          tables: {
            orders: {
              columns: {
                id: 'uuid',
                info: 'frozen<order_info>',
              },
              partition_key: ['id'],
            },
          },
        }),
        (err) => {
          assert.ok(err.message.includes('UDT "order_info"'));
          assert.ok(err.message.includes('undefined type "address"'));
          return true;
        }
      );
    });

    it('creates DDL and executes for schema with nested UDTs', async (t) => {
      if (skipIfNoDb(t)) return;

      const nestedKs = 'csg_nested_udt_test';

      // Cleanup from any prior run
      try { await client.execute(`DROP KEYSPACE IF EXISTS ${nestedKs}`); } catch { /* ignore */ }

      const nestedSchema = {
        keyspace: nestedKs,
        replication: { class: 'SimpleStrategy', replication_factor: 1 },
        types: {
          geo_point: {
            fields: { lat: 'double', lng: 'double' },
          },
          address: {
            fields: {
              street: 'text',
              city: 'text',
              zip: 'text',
              location: 'frozen<geo_point>',
            },
          },
        },
        tables: {
          stores: {
            columns: {
              store_id: 'uuid',
              name: 'text',
              main_address: 'frozen<address>',
              coordinates: 'frozen<geo_point>',
              secondary_addrs: 'list<frozen<address>>',
            },
            partition_key: ['store_id'],
          },
        },
      };

      // Registration should succeed (all UDTs are defined)
      const nestedRegistry = new SchemaRegistry();
      nestedRegistry.register(nestedSchema);
      const nestedDdl = new DDLGenerator(nestedRegistry);

      // Generate and execute DDL
      const stmts = nestedDdl.generateKeyspace(nestedKs);
      assert.ok(stmts.length > 0);

      for (const stmt of stmts) {
        await client.execute(stmt);
      }

      // Verify UDTs exist
      const udtResult = await client.execute(
        'SELECT type_name FROM system_schema.types WHERE keyspace_name = ?',
        [nestedKs], { prepare: true }
      );
      const udtNames = udtResult.rows.map(r => r.type_name).sort();
      assert.deepEqual(udtNames, ['address', 'geo_point']);

      // Verify table exists and has the right columns
      const colResult = await client.execute(
        'SELECT column_name, type FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
        [nestedKs, 'stores'], { prepare: true }
      );
      const colNames = colResult.rows.map(r => r.column_name).sort();
      assert.ok(colNames.includes('main_address'));
      assert.ok(colNames.includes('coordinates'));
      assert.ok(colNames.includes('secondary_addrs'));

      // Insert a row with nested UDT values
      const nestedCql = new CQLBuilder(nestedRegistry);
      const storeId = cassandra.types.Uuid.random();
      const { cql: insCql, params } = nestedCql.insert(nestedKs, 'stores')
        .values({
          store_id: storeId,
          name: 'Test Store',
          main_address: {
            street: '123 Main St',
            city: 'Boston',
            zip: '02101',
            location: { lat: 42.36, lng: -71.06 },
          },
          coordinates: { lat: 42.36, lng: -71.06 },
          secondary_addrs: [
            { street: '456 Oak Ave', city: 'Cambridge', zip: '02139', location: { lat: 42.37, lng: -71.09 } },
          ],
        })
        .build();

      await client.execute(insCql, params, { prepare: true });

      // Read back and verify
      const readResult = await client.execute(
        `SELECT * FROM ${nestedKs}.stores WHERE store_id = ?`,
        [storeId], { prepare: true }
      );
      assert.equal(readResult.rows.length, 1);
      assert.equal(readResult.rows[0].name, 'Test Store');
      assert.equal(readResult.rows[0].main_address.city, 'Boston');
      assert.equal(readResult.rows[0].coordinates.lat, 42.36);

      // Cleanup
      await client.execute(`DROP KEYSPACE IF EXISTS ${nestedKs}`);
    });

    it('introspected schema passes re-registration with UDT validation', async (t) => {
      if (skipIfNoDb(t)) return;

      // Introspect the live test keyspace (which has the 'address' UDT and
      // the 'users' table referencing it)
      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      // The introspector produces index objects with `type: null` and
      // `using` fields that don't conform to the meta-schema.
      // Normalize them so the meta-schema validation passes — we're testing
      // UDT cross-validation here, not introspector index fidelity.
      for (const tableDef of Object.values(liveSchema.tables)) {
        if (tableDef.indexes) {
          tableDef.indexes = tableDef.indexes.map(idx => {
            if (typeof idx === 'string') return idx;
            const cleaned = { column: idx.column };
            if (idx.name) cleaned.name = idx.name;
            if (idx.type && ['values', 'keys', 'entries', 'full'].includes(idx.type)) {
              cleaned.type = idx.type;
            }
            if (idx.using) cleaned.using = idx.using;
            return cleaned;
          });
        }
      }

      // Re-registering the introspected schema must pass cross-validation,
      // including the new UDT reference checks
      const freshRegistry = new SchemaRegistry();
      const ks = freshRegistry.register(liveSchema);
      assert.equal(ks, TEST_KEYSPACE);

      // The re-registered schema should be fully usable
      const freshCql = new CQLBuilder(freshRegistry);
      const id = cassandra.types.Uuid.random();
      const { cql: insCql, params } = freshCql.insert(TEST_KEYSPACE, 'users')
        .values({
          user_id: id,
          email: 'revalidated@test.com',
          name: 'Re-validated User',
        })
        .build();

      await client.execute(insCql, params, { prepare: true });

      // Verify
      const result = await client.execute(
        `SELECT email FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [id], { prepare: true }
      );
      assert.equal(result.rows[0].email, 'revalidated@test.com');

      // Cleanup
      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });

    it('collects all undefined UDT errors across multiple tables', (t) => {
      if (skipIfNoDb(t)) return;

      const badRegistry = new SchemaRegistry();
      assert.throws(
        () => badRegistry.register({
          keyspace: 'bad_multi',
          replication: { class: 'SimpleStrategy', replication_factor: 1 },
          tables: {
            table_a: {
              columns: {
                id: 'uuid',
                loc: 'frozen<geo_point>',
              },
              partition_key: ['id'],
            },
            table_b: {
              columns: {
                id: 'uuid',
                info: 'frozen<metadata>',
              },
              partition_key: ['id'],
            },
          },
        }),
        (err) => {
          // Both undefined types should be reported in a single error
          assert.ok(err.message.includes('geo_point'));
          assert.ok(err.message.includes('metadata'));
          return true;
        }
      );
    });
  });

  // ── CompatibilityChecker ──────────────────────────────────────────────

  describe('CompatibilityChecker — live schema validation', () => {
    it('verifies that the live schema is compatible with the local schema', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      // Extract the original schema from the registry
      const appSchema = registry.get(TEST_KEYSPACE);

      const checker = new CompatibilityChecker();
      const errors = checker.check(liveSchema, appSchema);

      // The DDL generated from appSchema was perfectly applied to Cassandra,
      // so the live schema should be fully compatible.
      assert.deepEqual(errors, []);
    });

    it('rejects compatibility if the local schema expects a column that is not in the live DB', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      // Clone appSchema and add a fake required column
      const appSchema = JSON.parse(JSON.stringify(registry.get(TEST_KEYSPACE)));
      appSchema.tables.users.columns.fake_required_col = { type: 'text' };

      const checker = new CompatibilityChecker();
      const errors = checker.check(liveSchema, appSchema);

      assert.equal(errors.length, 1);
      assert.match(errors[0], new RegExp(`Missing column: ${TEST_KEYSPACE}\\.users\\.fake_required_col`));
    });

    it('rejects compatibility if the local schema expects a table that is not in the live DB', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      const appSchema = JSON.parse(JSON.stringify(registry.get(TEST_KEYSPACE)));
      appSchema.tables.fake_future_table = {
        columns: { id: { type: 'uuid' } },
        partition_key: ['id'],
        clustering_key: []
      };

      const checker = new CompatibilityChecker();
      const errors = checker.check(liveSchema, appSchema);

      assert.equal(errors.length, 1);
      assert.match(errors[0], new RegExp(`Missing table: ${TEST_KEYSPACE}\\.fake_future_table`));
    });

    it('rejects compatibility if the local schema expects a different column type than the live DB', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      const appSchema = JSON.parse(JSON.stringify(registry.get(TEST_KEYSPACE)));
      // Live DB has 'text' for email, let's pretend app expects 'int'
      appSchema.tables.users.columns.email.type = 'int';

      const checker = new CompatibilityChecker();
      const errors = checker.check(liveSchema, appSchema);

      assert.equal(errors.length, 1);
      assert.match(errors[0], new RegExp(`Type mismatch in column ${TEST_KEYSPACE}\\.users\\.email: app expects int, but live has text`));
    });

    it('rejects compatibility if the primary key differs', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      const appSchema = JSON.parse(JSON.stringify(registry.get(TEST_KEYSPACE)));
      // Change clustering key expectation
      appSchema.tables.users.clustering_key = [{ column: 'email', order: 'ASC' }];

      const checker = new CompatibilityChecker();
      const errors = checker.check(liveSchema, appSchema);

      assert.ok(errors.length > 0);
      assert.match(errors[0], /Primary key mismatch/);
    });

    it('rejects compatibility if a required UDT is missing from the live DB', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      const appSchema = JSON.parse(JSON.stringify(registry.get(TEST_KEYSPACE)));
      // App expects a new UDT
      appSchema.types.future_udt = {
        fields: { loc: 'text' }
      };

      const checker = new CompatibilityChecker();
      const errors = checker.check(liveSchema, appSchema);

      assert.equal(errors.length, 1);
      assert.match(errors[0], new RegExp(`Missing UDT: ${TEST_KEYSPACE}\\.future_udt`));
    });

    it('rejects compatibility if a field inside a UDT is missing from the live DB', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      const appSchema = JSON.parse(JSON.stringify(registry.get(TEST_KEYSPACE)));
      // App expects a new field in the existing 'address' UDT
      appSchema.types.address.fields.planet = 'text';

      const checker = new CompatibilityChecker();
      const errors = checker.check(liveSchema, appSchema);

      assert.equal(errors.length, 1);
      assert.match(errors[0], new RegExp(`Missing UDT field: ${TEST_KEYSPACE}\\.address\\.planet`));
    });

    it('rejects compatibility if a field inside a UDT has a type mismatch', async (t) => {
      if (skipIfNoDb(t)) return;

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(TEST_KEYSPACE);

      const appSchema = JSON.parse(JSON.stringify(registry.get(TEST_KEYSPACE)));
      // Live DB has 'text' for city, app expects 'int'
      appSchema.types.address.fields.city = 'int';

      const checker = new CompatibilityChecker();
      const errors = checker.check(liveSchema, appSchema);

      assert.equal(errors.length, 1);
      assert.match(errors[0], new RegExp(`Type mismatch in UDT ${TEST_KEYSPACE}\\.address field "city": app expects int, but live has text`));
    });
  });

  // ── SELECT TTL/WRITETIME projections ─────────────────────────────────────

  describe('SELECT metadata projections (TTL/WRITETIME)', () => {
    it('reads back the remaining TTL through .ttl() after an INSERT with TTL', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();

      const ins = cql.insert(TEST_KEYSPACE, 'users')
        .values({ user_id: id, email: 'ttl-proj@test.com', name: 'TTL Projection' })
        .ttl(600)
        .build();
      await client.execute(ins.cql, ins.params, { prepare: true });

      const sel = cql.select(TEST_KEYSPACE, 'users')
        .columns('email')
        .ttl('email', 'email_ttl')
        .where('user_id', id)
        .build();
      const result = await client.execute(sel.cql, sel.params, { prepare: true });

      assert.equal(result.rows[0].email, 'ttl-proj@test.com');
      assert.ok(result.rows[0].email_ttl > 0, 'remaining TTL should be positive');
      assert.ok(result.rows[0].email_ttl <= 600, 'remaining TTL cannot exceed the insert TTL');

      // Cleanup
      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });

    it('projects a null TTL for a cell written without one', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();

      const ins = cql.insert(TEST_KEYSPACE, 'users')
        .values({ user_id: id, email: 'no-ttl@test.com', name: 'No TTL' })
        .build();
      await client.execute(ins.cql, ins.params, { prepare: true });

      const sel = cql.select(TEST_KEYSPACE, 'users')
        .ttl('email', 'email_ttl')
        .where('user_id', id)
        .build();
      const result = await client.execute(sel.cql, sel.params, { prepare: true });

      assert.equal(result.rows[0].email_ttl, null);

      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });

    it('reads the write timestamp through .writetime()', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();
      const beforeMicros = Date.now() * 1000;

      const ins = cql.insert(TEST_KEYSPACE, 'users')
        .values({ user_id: id, email: 'wt@test.com', name: 'Writetime' })
        .build();
      await client.execute(ins.cql, ins.params, { prepare: true });

      const sel = cql.select(TEST_KEYSPACE, 'users')
        .writetime('email', 'wt')
        .where('user_id', id)
        .build();
      const result = await client.execute(sel.cql, sel.params, { prepare: true });

      // WRITETIME is microseconds since epoch (driver returns a Long)
      const wt = Number(result.rows[0].wt.toString());
      assert.ok(wt >= beforeMicros - 60_000_000, 'writetime should be around now');

      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });

    it('the guard rules mirror the server: TTL on a primary key column is rejected by Cassandra too', async (t) => {
      if (skipIfNoDb(t)) return;

      // The builder throws for .ttl('user_id') — prove the server agrees
      await assert.rejects(
        client.execute(`SELECT TTL(user_id) FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
          [cassandra.types.Uuid.random()], { prepare: true }),
        /(PRIMARY KEY|primary key)/i
      );
    });

    it('version gate matches the server exactly: TTL on collections per detected release', async (t) => {
      if (skipIfNoDb(t)) return;

      // Cassandra 4.x rejects TTL(collection) outright, 5.0+ accepts it and
      // returns a per-cell LIST. Detect the release and prove the builder's
      // gate agrees with THIS server on both sides of the cutoff.
      const version = await new LiveSchemaIntrospector(client).releaseVersion();
      const versionAware = new CQLBuilder(registry, { cassandraVersion: version });
      console.log(`    detected Cassandra ${version}`);

      if (versionAtLeast(version, VERSION_FEATURES.collectionCellMetadata)) {
        // 5.0+: the version-aware builder allows it AND the server executes it
        const sel = versionAware.select(TEST_KEYSPACE, 'users')
          .ttl('tags', 'tags_ttl')
          .where('user_id', cassandra.types.Uuid.random())
          .build();
        const result = await client.execute(sel.cql, sel.params, { prepare: true });
        assert.equal(result.rows.length, 0); // no row — the point is it EXECUTED
      } else {
        // 4.x: the version-aware builder rejects it AND so does the server
        assert.throws(
          () => versionAware.select(TEST_KEYSPACE, 'users').ttl('tags'),
          /needs Cassandra/
        );
        await assert.rejects(
          client.execute(`SELECT TTL(tags) FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
            [cassandra.types.Uuid.random()], { prepare: true }),
          /ttl on non-frozen collection/i
        );
      }

      // With no version configured the builder stays conservative everywhere
      assert.throws(() => cql.select(TEST_KEYSPACE, 'users').ttl('tags'), /multi-cell/);
    });

    it('releaseVersion() reports the server release from system.local', async (t) => {
      if (skipIfNoDb(t)) return;

      const version = await new LiveSchemaIntrospector(client).releaseVersion();
      assert.match(version, /^\d+\.\d+/);

      const raw = await client.execute('SELECT release_version FROM system.local');
      assert.equal(version, raw.rows[0].release_version);
    });
  });

  // ── DELETE element removal ────────────────────────────────────────────────

  describe('DELETE element removal', () => {
    it('removes a single map entry and leaves the rest', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();

      const ins = cql.insert(TEST_KEYSPACE, 'users')
        .values({
          user_id: id,
          email: 'map-del@test.com',
          name: 'Map Delete',
          preferences: { theme: 'dark', lang: 'en' },
        })
        .build();
      await client.execute(ins.cql, ins.params, { prepare: true });

      const del = cql.delete(TEST_KEYSPACE, 'users')
        .element('preferences', 'theme')
        .where('user_id', id)
        .build();
      await client.execute(del.cql, del.params, { prepare: true });

      const result = await client.execute(
        `SELECT preferences FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [id], { prepare: true }
      );
      assert.deepEqual(result.rows[0].preferences, { lang: 'en' });

      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });

    it('removes a single list element by index and reindexes the rest', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();
      const orderId = cassandra.types.TimeUuid.now();

      const ins = cql.insert(TEST_KEYSPACE, 'orders_by_user')
        .values({
          user_id: id,
          order_id: orderId,
          status: 'pending',
          items: ['alpha', 'beta', 'gamma'],
        })
        .build();
      await client.execute(ins.cql, ins.params, { prepare: true });

      const del = cql.delete(TEST_KEYSPACE, 'orders_by_user')
        .element('items', 1)
        .where('user_id', id)
        .where('order_id', orderId)
        .build();
      await client.execute(del.cql, del.params, { prepare: true });

      const result = await client.execute(
        `SELECT items FROM ${TEST_KEYSPACE}.orders_by_user WHERE user_id = ? AND order_id = ?`,
        [id, orderId], { prepare: true }
      );
      assert.deepEqual(result.rows[0].items, ['alpha', 'gamma']);

      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.orders_by_user WHERE user_id = ?`, [id], { prepare: true });
    });

    it('mixes a whole-column delete with an element delete in one statement', async (t) => {
      if (skipIfNoDb(t)) return;

      const id = cassandra.types.Uuid.random();

      const ins = cql.insert(TEST_KEYSPACE, 'users')
        .values({
          user_id: id,
          email: 'mixed-del@test.com',
          name: 'Mixed Delete',
          preferences: { theme: 'dark', lang: 'en' },
        })
        .build();
      await client.execute(ins.cql, ins.params, { prepare: true });

      const del = cql.delete(TEST_KEYSPACE, 'users')
        .columns('name')
        .element('preferences', 'lang')
        .where('user_id', id)
        .build();
      await client.execute(del.cql, del.params, { prepare: true });

      const result = await client.execute(
        `SELECT name, preferences FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`,
        [id], { prepare: true }
      );
      assert.equal(result.rows[0].name, null);
      assert.deepEqual(result.rows[0].preferences, { theme: 'dark' });

      await client.execute(`DELETE FROM ${TEST_KEYSPACE}.users WHERE user_id = ?`, [id], { prepare: true });
    });
  });
});
