const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SchemaRegistry } = require('../src/SchemaRegistry');
const { DDLGenerator } = require('../src/DDLGenerator');
const { MigrationDiffer } = require('../src/MigrationDiffer');

describe('DDLGenerator', () => {
  function makeRegistry() {
    const r = new SchemaRegistry();
    r.loadFromFile(path.join(__dirname, '..', 'schemas', 'ecommerce.json'));
    return r;
  }

  it('generates CREATE KEYSPACE', () => {
    const r = makeRegistry();
    const gen = new DDLGenerator(r);
    const stmts = gen.generateKeyspace('ecommerce');
    const ksStmt = stmts.find(s => s.includes('CREATE KEYSPACE'));
    assert.ok(ksStmt);
    assert.match(ksStmt, /NetworkTopologyStrategy/);
    assert.match(ksStmt, /'dc1': 3/);
  });

  it('generates CREATE TYPE', () => {
    const r = makeRegistry();
    const gen = new DDLGenerator(r);
    const stmts = gen.generateKeyspace('ecommerce');
    const typeStmt = stmts.find(s => s.includes('CREATE TYPE'));
    assert.ok(typeStmt);
    assert.match(typeStmt, /address/);
    assert.match(typeStmt, /street text/);
  });

  it('generates CREATE TABLE with primary key', () => {
    const r = makeRegistry();
    const gen = new DDLGenerator(r);
    const stmts = gen.generateKeyspace('ecommerce');
    const userTable = stmts.find(s => s.includes('CREATE TABLE') && s.includes('users'));
    assert.ok(userTable);
    assert.match(userTable, /PRIMARY KEY \(user_id\)/);
  });

  it('generates CREATE TABLE with composite partition key', () => {
    const r = makeRegistry();
    const gen = new DDLGenerator(r);
    const stmts = gen.generateKeyspace('ecommerce');
    const ordersByStatus = stmts.find(s => s.includes('orders_by_status'));
    assert.ok(ordersByStatus);
    assert.match(ordersByStatus, /PRIMARY KEY \(\(status, order_date\), order_id\)/);
  });

  it('generates CLUSTERING ORDER BY for DESC tables', () => {
    const r = makeRegistry();
    const gen = new DDLGenerator(r);
    const stmts = gen.generateKeyspace('ecommerce');
    const ordersTable = stmts.find(s => s.includes('orders_by_user') && s.includes('CREATE TABLE'));
    assert.ok(ordersTable);
    assert.match(ordersTable, /CLUSTERING ORDER BY \(order_id DESC\)/);
  });

  it('generates CREATE INDEX', () => {
    const r = makeRegistry();
    const gen = new DDLGenerator(r);
    const stmts = gen.generateKeyspace('ecommerce');
    const emailIdx = stmts.find(s => s.includes('CREATE INDEX') && s.includes('email'));
    assert.ok(emailIdx);
  });

  it('generates named index with type', () => {
    const r = makeRegistry();
    const gen = new DDLGenerator(r);
    const stmts = gen.generateKeyspace('ecommerce');
    const tagsIdx = stmts.find(s => s.includes('idx_users_tags'));
    assert.ok(tagsIdx);
    assert.match(tagsIdx, /VALUES\(tags\)/);
  });

  it('generates table options', () => {
    const r = makeRegistry();
    const gen = new DDLGenerator(r);
    const stmts = gen.generateKeyspace('ecommerce');
    const ordersTable = stmts.find(s => s.includes('orders_by_user') && s.includes('CREATE TABLE'));
    assert.ok(ordersTable);
    assert.match(ordersTable, /gc_grace_seconds = 864000/);
  });

  it('generates single table DDL', () => {
    const r = makeRegistry();
    const gen = new DDLGenerator(r);
    const stmts = gen.generateTable('ecommerce', 'products');
    assert.ok(stmts.length >= 1);
    assert.match(stmts[0], /CREATE TABLE.*products/);
  });
});

describe('MigrationDiffer', () => {
  function makeSchema(overrides = {}) {
    const base = {
      keyspace: 'test_ks',
      replication: { class: 'SimpleStrategy', replication_factor: 1 },
      types: {},
      tables: {
        users: {
          columns: {
            user_id: { type: 'uuid', static: false },
            email: { type: 'text', static: false },
            name: { type: 'text', static: false },
          },
          partition_key: ['user_id'],
          clustering_key: [],
          indexes: [],
          options: {},
        },
      },
    };
    const tables = 'tables' in overrides ? overrides.tables : base.tables;
    return { ...base, ...overrides, tables };
  }

  it('detects no changes', () => {
    const differ = new MigrationDiffer();
    const schema = makeSchema();
    const result = differ.diff(schema, schema);
    assert.equal(result.statements.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.breaking.length, 0);
  });

  it('detects new table', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema();
    const newSchema = makeSchema({
      tables: {
        users: oldSchema.tables.users,
        products: {
          columns: {
            product_id: { type: 'uuid', static: false },
            name: { type: 'text', static: false },
          },
          partition_key: ['product_id'],
          clustering_key: [],
          indexes: [],
          options: {},
        },
      },
    });
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.statements.some(s => s.includes('CREATE TABLE') && s.includes('products')));
  });

  it('detects dropped table', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema();
    const newSchema = makeSchema({ tables: {} });
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.statements.some(s => s.includes('DROP TABLE')));
    assert.ok(result.breaking.length > 0);
  });

  it('detects added column', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema();
    const newSchema = makeSchema();
    newSchema.tables.users.columns.age = { type: 'int', static: false };
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.statements.some(s => s.includes('ALTER TABLE') && s.includes('ADD age int')));
  });

  it('detects dropped column', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema();
    const newSchema = makeSchema();
    delete newSchema.tables.users.columns.name;
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.statements.some(s => s.includes('DROP name')));
    assert.ok(result.breaking.length > 0);
  });

  it('detects replication change', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema();
    const newSchema = makeSchema({ replication: { class: 'SimpleStrategy', replication_factor: 3 } });
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.statements.some(s => s.includes('ALTER KEYSPACE')));
    assert.ok(result.warnings.some(w => w.includes('Replication')));
  });

  it('detects primary key change (warning)', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema();
    const newSchema = makeSchema();
    newSchema.tables.users.clustering_key = [{ column: 'email', order: 'ASC' }];
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.warnings.some(w => w.includes('Primary key')));
    assert.ok(result.breaking.length > 0);
  });

  it('detects new index', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema();
    const newSchema = makeSchema();
    newSchema.tables.users.indexes = [{ column: 'email', name: null, type: null, using: null }];
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.statements.some(s => s.includes('CREATE INDEX') && s.includes('email')));
  });

  it('detects dropped index', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema();
    oldSchema.tables.users.indexes = [{ column: 'email', name: 'idx_email', type: null, using: null }];
    const newSchema = makeSchema();
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.statements.some(s => s.includes('DROP INDEX')));
  });

  it('detects table option changes', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema();
    const newSchema = makeSchema();
    newSchema.tables.users.options = { gc_grace_seconds: 86400 };
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.statements.some(s => s.includes('ALTER TABLE') && s.includes('gc_grace_seconds')));
  });

  it('detects new UDT', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema();
    const newSchema = makeSchema({
      types: { address: { fields: { street: 'text', city: 'text' } } },
    });
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.statements.some(s => s.includes('CREATE TYPE') && s.includes('address')));
  });

  it('detects new UDT field', () => {
    const differ = new MigrationDiffer();
    const oldSchema = makeSchema({
      types: { address: { fields: { street: 'text' } } },
    });
    const newSchema = makeSchema({
      types: { address: { fields: { street: 'text', city: 'text' } } },
    });
    const result = differ.diff(oldSchema, newSchema);
    assert.ok(result.statements.some(s => s.includes('ALTER TYPE') && s.includes('ADD city')));
  });

  it('rejects diffing different keyspaces', () => {
    const differ = new MigrationDiffer();
    assert.throws(
      () => differ.diff(makeSchema(), makeSchema({ keyspace: 'other' })),
      /different keyspaces/
    );
  });
});
