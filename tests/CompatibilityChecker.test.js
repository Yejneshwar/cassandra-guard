const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CompatibilityChecker } = require('../src/CompatibilityChecker');

describe('CompatibilityChecker', () => {
  const checker = new CompatibilityChecker();

  const appSchema = {
    keyspace: 'ecommerce',
    types: {
      address: {
        fields: {
          street: 'text',
          city: 'text'
        }
      }
    },
    tables: {
      users: {
        columns: {
          id: { type: 'uuid' },
          name: { type: 'text' },
          addr: { type: 'frozen<address>' }
        },
        partition_key: ['id'],
        clustering_key: [],
        indexes: ['name']
      }
    }
  };

  it('passes perfectly compatible schema', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    const errors = checker.check(liveSchema, appSchema);
    assert.deepEqual(errors, []);
  });

  it('passes when live database has extra tables', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.tables.extra_table = {
      columns: { id: { type: 'uuid' } },
      partition_key: ['id'],
      clustering_key: []
    };
    const errors = checker.check(liveSchema, appSchema);
    assert.deepEqual(errors, []);
  });

  it('passes when live database has extra columns', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.tables.users.columns.extra_col = { type: 'text' };
    const errors = checker.check(liveSchema, appSchema);
    assert.deepEqual(errors, []);
  });

  it('passes when live database has extra UDTs and fields', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.types.address.fields.zip = 'text'; // extra field
    liveSchema.types.extra_type = { fields: { a: 'text' } }; // extra UDT
    const errors = checker.check(liveSchema, appSchema);
    assert.deepEqual(errors, []);
  });

  it('fails on keyspace mismatch', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.keyspace = 'wrong_ks';
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Keyspace mismatch/);
  });

  it('fails when live database is missing a table', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    delete liveSchema.tables.users;
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Missing table/);
  });

  it('fails when live database is missing a column', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    delete liveSchema.tables.users.columns.name;
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Missing column/);
  });

  it('fails on column type mismatch', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.tables.users.columns.name.type = 'int';
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Type mismatch in column/);
  });

  it('fails on column static mismatch', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.tables.users.columns.name.static = true;
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Static mismatch in column/);
  });

  it('fails when live database is missing an index', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.tables.users.indexes = [];
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Missing index/);
  });

  it('fails when live database has different primary key', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.tables.users.clustering_key = [{ column: 'name', order: 'ASC' }];
    const errors = checker.check(liveSchema, appSchema);
    assert.ok(errors.length >= 1);
    assert.match(errors[0], /Primary key mismatch/);
  });

  it('fails when live database is missing a UDT', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    delete liveSchema.types.address;
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Missing UDT/);
  });

  it('fails when live database is missing a UDT field', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    delete liveSchema.types.address.fields.street;
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Missing UDT field/);
  });

  it('fails when live database has UDT field type mismatch', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.types.address.fields.street = 'int';
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Type mismatch in UDT/);
  });
});

describe('CompatibilityChecker nested-UDT frozen normalization', () => {
  const checker = new CompatibilityChecker();

  // Everything nested inside a UDT is implicitly frozen (non-frozen UDTs are
  // only legal as top-level columns), and system_schema reports the spelling
  // the type was DECLARED with — so a legacy `CREATE TYPE` without frozen<>
  // reads back bare while a frozen<> declaration reads back wrapped. Both
  // describe the same schema and no ALTER can convert between them.
  const appSchema = {
    keyspace: 'cube_user_addresses',
    types: {
      iso: { fields: { country_alpha_2: 'text' } },
      mapbounds: { fields: { north: 'float' } },
      metadata: { fields: { lat: 'float', mapbounds: 'frozen<mapbounds>', iso: 'frozen<iso>' } },
      user_address_v2: { fields: { a_id: 'uuid', metadata: 'frozen<metadata>' } },
      item: { fields: { sku: 'text' } },
      order_info: { fields: { items: 'map<uuid, frozen<item>>' } }
    },
    tables: {
      addresses: {
        columns: { a_id: { type: 'uuid' }, addr: { type: 'frozen<user_address_v2>' } },
        partition_key: ['a_id'],
        clustering_key: []
      }
    }
  };

  it('treats bare and frozen<> nested UDT fields as identical (legacy-declared live schema)', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.types.metadata.fields.mapbounds = 'mapbounds';
    liveSchema.types.metadata.fields.iso = 'iso';
    liveSchema.types.user_address_v2.fields.metadata = 'metadata';
    assert.deepEqual(checker.check(liveSchema, appSchema), []);
  });

  it('normalizes in both directions (frozen-declared live vs bare app)', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    const bareApp = JSON.parse(JSON.stringify(appSchema));
    bareApp.types.metadata.fields.mapbounds = 'mapbounds';
    assert.deepEqual(checker.check(liveSchema, bareApp), []);
  });

  it('normalizes UDTs nested inside collection generics within UDT fields', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.types.order_info.fields.items = 'map<uuid, item>';
    assert.deepEqual(checker.check(liveSchema, appSchema), []);
  });

  it('still flags REAL UDT field type mismatches', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.types.metadata.fields.lat = 'double';
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Type mismatch in UDT .*metadata field "lat"/);
  });

  it('does NOT normalize table columns — top-level frozen-ness is a real difference', () => {
    const liveSchema = JSON.parse(JSON.stringify(appSchema));
    liveSchema.tables.addresses.columns.addr = { type: 'user_address_v2' };
    const errors = checker.check(liveSchema, appSchema);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Type mismatch in column .*addr/);
  });
});
