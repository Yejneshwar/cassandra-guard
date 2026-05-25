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
