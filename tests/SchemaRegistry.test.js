const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SchemaRegistry, SchemaValidationError } = require('../src/SchemaRegistry');

describe('SchemaRegistry', () => {
  function makeRegistry() {
    const r = new SchemaRegistry();
    r.loadFromFile(path.join(__dirname, '..', 'schemas', 'ecommerce.json'));
    return r;
  }

  it('loads a valid schema from file', () => {
    const r = new SchemaRegistry();
    const ks = r.loadFromFile(path.join(__dirname, '..', 'schemas', 'ecommerce.json'));
    assert.equal(ks, 'ecommerce');
  });

  it('rejects invalid JSON schema', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({ tables: {} }), SchemaValidationError);
  });

  it('rejects schema with missing partition key column', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({
      keyspace: 'test',
      tables: {
        bad: {
          columns: { a: 'text' },
          partition_key: ['nonexistent'],
        },
      },
    }), SchemaValidationError);
  });

  it('rejects schema with bad clustering key reference', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({
      keyspace: 'test',
      tables: {
        bad: {
          columns: { a: 'text' },
          partition_key: ['a'],
          clustering_key: [{ column: 'ghost', order: 'ASC' }],
        },
      },
    }), SchemaValidationError);
  });

  it('lists keyspaces', () => {
    const r = makeRegistry();
    assert.deepEqual(r.listKeyspaces(), ['ecommerce']);
  });

  it('lists tables', () => {
    const r = makeRegistry();
    const tables = r.listTables('ecommerce');
    assert.ok(tables.includes('users'));
    assert.ok(tables.includes('orders_by_user'));
    assert.ok(tables.includes('products'));
  });

  it('gets columns for a table', () => {
    const r = makeRegistry();
    const cols = r.getColumns('ecommerce', 'users');
    assert.ok(cols.includes('user_id'));
    assert.ok(cols.includes('email'));
    assert.ok(cols.includes('tags'));
  });

  it('gets column type', () => {
    const r = makeRegistry();
    assert.equal(r.getColumnType('ecommerce', 'users', 'user_id'), 'uuid');
    assert.equal(r.getColumnType('ecommerce', 'users', 'tags'), 'set<text>');
  });

  it('throws on unknown keyspace', () => {
    const r = makeRegistry();
    assert.throws(() => r.get('nonexistent'), /No schema registered/);
  });

  it('throws on unknown table', () => {
    const r = makeRegistry();
    assert.throws(() => r.getTable('ecommerce', 'fake'), /not found/);
  });

  it('throws on unknown column', () => {
    const r = makeRegistry();
    assert.throws(
      () => r.getColumnType('ecommerce', 'users', 'fake_col'),
      /not found/
    );
  });

  it('returns partition key', () => {
    const r = makeRegistry();
    assert.deepEqual(r.getPartitionKey('ecommerce', 'users'), ['user_id']);
    assert.deepEqual(r.getPartitionKey('ecommerce', 'orders_by_status'), ['status', 'order_date']);
  });

  it('returns clustering key with order', () => {
    const r = makeRegistry();
    const ck = r.getClusteringKey('ecommerce', 'orders_by_user');
    assert.equal(ck.length, 1);
    assert.equal(ck[0].column, 'order_id');
    assert.equal(ck[0].order, 'DESC');
  });

  it('returns full primary key', () => {
    const r = makeRegistry();
    const pk = r.getPrimaryKey('ecommerce', 'orders_by_status');
    assert.deepEqual(pk, ['status', 'order_date', 'order_id']);
  });

  it('normalizes string column defs to objects', () => {
    const r = makeRegistry();
    const schema = r.get('ecommerce');
    // All columns should be objects after normalization
    for (const [, table] of Object.entries(schema.tables)) {
      for (const [, col] of Object.entries(table.columns)) {
        assert.equal(typeof col, 'object');
        assert.ok('type' in col);
      }
    }
  });

  it('loads all schemas from a directory', () => {
    const r = new SchemaRegistry();
    const loaded = r.loadFromDirectory(path.join(__dirname, '..', 'schemas'));
    assert.ok(loaded.length >= 1);
    assert.ok(loaded.includes('ecommerce'));
  });
});
