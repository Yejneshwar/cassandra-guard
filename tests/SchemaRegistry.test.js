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

  // ── UDT reference validation ──────────────────────────────────────────────

  it('rejects column with frozen<udt> referencing undefined type', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({
      keyspace: 'test',
      tables: {
        users: {
          columns: { id: 'uuid', addr: 'frozen<address>' },
          partition_key: ['id'],
        },
      },
    }), (err) => {
      assert.ok(err instanceof SchemaValidationError);
      assert.ok(err.message.includes('undefined type "address"'));
      return true;
    });
  });

  it('rejects column with bare UDT name referencing undefined type', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({
      keyspace: 'test',
      tables: {
        users: {
          columns: { id: 'uuid', addr: 'address' },
          partition_key: ['id'],
        },
      },
    }), (err) => {
      assert.ok(err instanceof SchemaValidationError);
      assert.ok(err.message.includes('undefined type "address"'));
      return true;
    });
  });

  it('rejects column with list<frozen<udt>> referencing undefined type', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({
      keyspace: 'test',
      tables: {
        users: {
          columns: { id: 'uuid', addrs: 'list<frozen<address>>' },
          partition_key: ['id'],
        },
      },
    }), (err) => {
      assert.ok(err instanceof SchemaValidationError);
      assert.ok(err.message.includes('undefined type "address"'));
      return true;
    });
  });

  it('rejects column with map value referencing undefined UDT', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({
      keyspace: 'test',
      tables: {
        users: {
          columns: { id: 'uuid', addrs: 'map<text, frozen<location>>' },
          partition_key: ['id'],
        },
      },
    }), (err) => {
      assert.ok(err instanceof SchemaValidationError);
      assert.ok(err.message.includes('undefined type "location"'));
      return true;
    });
  });

  it('rejects column with object-style column def referencing undefined UDT', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({
      keyspace: 'test',
      tables: {
        users: {
          columns: {
            id: 'uuid',
            addr: { type: 'frozen<address>', static: false },
          },
          partition_key: ['id'],
        },
      },
    }), (err) => {
      assert.ok(err instanceof SchemaValidationError);
      assert.ok(err.message.includes('undefined type "address"'));
      return true;
    });
  });

  it('accepts column referencing a defined UDT', () => {
    const r = new SchemaRegistry();
    // Should NOT throw — 'address' is defined in types
    const ks = r.register({
      keyspace: 'test',
      types: {
        address: {
          fields: { street: 'text', city: 'text' },
        },
      },
      tables: {
        users: {
          columns: {
            id: 'uuid',
            home: 'frozen<address>',
            work: 'address',
            addrs: 'list<frozen<address>>',
          },
          partition_key: ['id'],
        },
      },
    });
    assert.equal(ks, 'test');
  });

  it('rejects UDT field referencing undefined type', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({
      keyspace: 'test',
      types: {
        order_info: {
          fields: {
            id: 'uuid',
            shipping: 'frozen<address>',
          },
        },
      },
      tables: {
        orders: {
          columns: { id: 'uuid', info: 'frozen<order_info>' },
          partition_key: ['id'],
        },
      },
    }), (err) => {
      assert.ok(err instanceof SchemaValidationError);
      assert.ok(err.message.includes('UDT "order_info"'));
      assert.ok(err.message.includes('undefined type "address"'));
      return true;
    });
  });

  it('accepts UDT fields referencing other defined UDTs', () => {
    const r = new SchemaRegistry();
    const ks = r.register({
      keyspace: 'test',
      types: {
        address: {
          fields: { street: 'text', city: 'text' },
        },
        order_info: {
          fields: {
            id: 'uuid',
            shipping: 'frozen<address>',
          },
        },
      },
      tables: {
        orders: {
          columns: { id: 'uuid', info: 'frozen<order_info>' },
          partition_key: ['id'],
        },
      },
    });
    assert.equal(ks, 'test');
  });

  it('collects multiple UDT errors in one throw', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({
      keyspace: 'test',
      tables: {
        t1: {
          columns: {
            id: 'uuid',
            a: 'frozen<type_a>',
            b: 'frozen<type_b>',
          },
          partition_key: ['id'],
        },
      },
    }), (err) => {
      assert.ok(err instanceof SchemaValidationError);
      assert.ok(err.message.includes('type_a'));
      assert.ok(err.message.includes('type_b'));
      return true;
    });
  });

  it('does not flag native types as undefined UDTs', () => {
    const r = new SchemaRegistry();
    // All native types should pass without needing a types section
    const ks = r.register({
      keyspace: 'test',
      tables: {
        all_native: {
          columns: {
            a: 'text', b: 'int', c: 'uuid', d: 'bigint',
            e: 'boolean', f: 'timestamp', g: 'float', h: 'double',
            i: 'decimal', j: 'varint', k: 'inet', l: 'blob',
            m: 'date', n: 'time', o: 'timeuuid', p: 'smallint',
            q: 'tinyint', r: 'ascii', s: 'varchar', t: 'duration',
            u: 'counter',
          },
          partition_key: ['a'],
        },
      },
    });
    assert.equal(ks, 'test');
  });

  it('does not flag collection types with only native inner types', () => {
    const r = new SchemaRegistry();
    const ks = r.register({
      keyspace: 'test',
      tables: {
        collections: {
          columns: {
            id: 'uuid',
            tags: 'set<text>',
            scores: 'list<int>',
            meta: 'map<text, text>',
            coords: 'tuple<double, double>',
            data: 'frozen<map<text, int>>',
          },
          partition_key: ['id'],
        },
      },
    });
    assert.equal(ks, 'test');
  });

  // ── MV clustering key validation ──────────────────────────────────────────

  it('rejects MV with clustering key referencing non-existent base column', () => {
    const r = new SchemaRegistry();
    assert.throws(() => r.register({
      keyspace: 'test',
      tables: {
        orders: {
          columns: { id: 'uuid', status: 'text', total: 'int' },
          partition_key: ['id'],
          materialized_views: {
            orders_by_status: {
              select: ['*'],
              partition_key: ['status'],
              clustering_key: [{ column: 'ghost_col', order: 'ASC' }],
              where: ['status IS NOT NULL', 'id IS NOT NULL'],
            },
          },
        },
      },
    }), (err) => {
      assert.ok(err instanceof SchemaValidationError);
      assert.ok(err.message.includes('clustering key column "ghost_col" not found'));
      return true;
    });
  });
});
