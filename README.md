# Cassandra Schema Guard

A schema registry, validated CQL builder, DDL generator, and migration differ for Apache Cassandra. Define your schema in JSON, and all CQL gets validated against it at build time — not at deploy time.

## Why?

Cassandra doesn't enforce a lot of the things that can go wrong: referencing a column that doesn't exist, updating a primary key, or forgetting to include the full partition key in a WHERE clause. These blow up at runtime. This library catches them before your code ever hits a cluster.

**Core idea:** A CQL statement can only be constructed against a JSON-based known schema. Tests don't break, and the schema can be verified before deployment.

## Install

```bash
npm install cassandra-guard
```

## Quick Start

```javascript
const { SchemaRegistry, CQLBuilder } = require('cassandra-guard');

// 1. Load your schema
const registry = new SchemaRegistry();
registry.loadFromFile('./schemas/ecommerce.json');

// 2. Build validated CQL
const cql = new CQLBuilder(registry);

const query = cql.select('ecommerce', 'users')
  .columns('user_id', 'email', 'name')
  .where('user_id', 'some-uuid')
  .build();

// → { cql: 'SELECT user_id, email, name FROM ecommerce.users WHERE user_id = ?',
//     params: ['some-uuid'] }

// This throws CQLBuildError — "nonexistent" isn't in the schema:
cql.select('ecommerce', 'users').columns('nonexistent');
// → CQLBuildError: Column "nonexistent" does not exist in ecommerce.users
```

## Schema Definition

Define your keyspace in a JSON file:

```json
{
  "keyspace": "my_app",
  "version": "1.0.0",
  "replication": {
    "class": "NetworkTopologyStrategy",
    "dc1": 3
  },
  "types": {
    "address": {
      "fields": { "street": "text", "city": "text", "zip": "text" }
    }
  },
  "tables": {
    "users": {
      "columns": {
        "user_id": "uuid",
        "email": "text",
        "name": "text",
        "tags": "set<text>",
        "prefs": "map<text, text>"
      },
      "partition_key": ["user_id"],
      "clustering_key": [],
      "indexes": ["email"],
      "options": {
        "gc_grace_seconds": 864000
      }
    },
    "events_by_user": {
      "columns": {
        "user_id": "uuid",
        "event_id": "timeuuid",
        "event_type": "text",
        "payload": "text"
      },
      "partition_key": ["user_id"],
      "clustering_key": [
        { "column": "event_id", "order": "DESC" }
      ]
    }
  }
}
```

Columns can be strings (`"uuid"`) or objects for more detail:

```json
"stock_count": {
  "type": "int",
  "static": true,
  "description": "Current stock level"
}
```

## CQL Builder — Full DML

### SELECT

```javascript
cql.select('ks', 'table')
  .columns('col1', 'col2')       // validated against schema
  .ttl('col2', 'expires_at')     // TTL(col2) AS expires_at — regular single-cell columns only
  .writetime('col2')             // WRITETIME(col2)
  .where('pk_col', value)         // = operator
  .where('ck_col', '>', value)    // comparison operators
  .where('pk_col', 'IN', [a, b]) // IN queries
  .orderBy('ck_col', 'DESC')     // only clustering columns allowed
  .limit(100)
  .perPartitionLimit(10)
  .allowFiltering()
  .distinct()                    // cannot be combined with ttl()/writetime()
  .build();
```

> **TTL/WRITETIME projections:** `.ttl(column, alias?)` and `.writetime(column, alias?)` validate that the column exists and is not part of the primary key (key columns have no cell metadata). Non-frozen collections are rejected by default — Cassandra 5.0+ can select their per-cell metadata as a LIST, so this is opt-in via version-aware validation (see below).

### INSERT

```javascript
cql.insert('ks', 'table')
  .values({ pk_col: 'val', col2: 'val2' }) // must include full primary key
  .ttl(3600)                               // or ttl(0) to explicitly clear TTL
  .timestamp(Date.now() * 1000)
  .ifNotExists()
  .build();
```

### UPDATE

```javascript
cql.update('ks', 'table')
  .set('col', 'new_value')            // cannot SET primary key columns
  .setAll({ col1: 'a', col2: 'b' })
  .setField('address', 'city', 'NYC') // UDT subfield: SET address.city = ?
  .addToSet('tags', new Set(['vip'])) // validates column is set<...>
  .removeFromSet('tags', new Set(['old']))
  .appendToList('items', ['new'])     // validates column is list<...>
  .prependToList('items', ['first'])
  .putToMap('prefs', 'key', 'value')  // validates column is map<...>
  .where('pk_col', value)             // must include full primary key
  .if_('col', 'expected_value')       // lightweight transactions
  .ifExists()
  .ttl(7200)                          // or ttl(0) to clear TTL
  .build();
```

> **UDT subfield updates:** `.setField(column, field, value)` validates that the column is a non-frozen UDT and the field exists in the schema's `types` definition. Frozen UDT columns are rejected at build time — use `.set('address', {...})` to replace the entire value instead.

### DELETE

```javascript
cql.delete('ks', 'table')
  .columns('col1', 'col2')      // optional: specific columns
  .element('map_col', 'key')    // DELETE map_col[?] — map key or list index
  .where('pk_col', value)
  .if_('col', 'expected')
  .ifExists()
  .timestamp(ts)
  .build();
```

> **Element deletion:** `.element(column, key)` validates that the column is a non-frozen `map<...>` or `list<...>`. Sets are rejected — CQL has no set element deletion; remove by value with `UPDATE ... removeFromSet()` instead. Element keys bind in statement order, before the WHERE params.

### BATCH

```javascript
const ins = cql.insert('ks', 'table').values({...});
const upd = cql.update('ks', 'table').set('col', 'val').where('pk', v);

cql.batch('LOGGED')  // or 'UNLOGGED', 'COUNTER'
  .add(ins)
  .add(upd)
  .timestamp(ts)
  .build();
```

## Server-Side Functions

Use `CQLBuilder.fn()` to safely insert Cassandra server-side functions like `now()`, `uuid()`, or `toTimestamp(now())` into your queries. Only whitelisted function names are allowed — arbitrary strings are rejected to prevent CQL injection.

```javascript
// INSERT with server-generated timestamp
cql.insert('ks', 'orders')
  .values({
    user_id: 'uid-1',
    order_id: CQLBuilder.fn('now'),                              // → now()
    created_at: CQLBuilder.fn('toTimestamp', CQLBuilder.fn('now')), // → toTimestamp(now())
    status: 'pending',
  })
  .build();
// → VALUES (?, now(), toTimestamp(now()), ?)
//   params: ['uid-1', 'pending']  — functions are NOT parameterized

// UPDATE with server-side timestamp
cql.update('ks', 'users')
  .set('updated_at', CQLBuilder.fn('toTimestamp', CQLBuilder.fn('now')))
  .where('user_id', 'uid-1')
  .build();
// → SET updated_at = toTimestamp(now()) WHERE user_id = ?

// Primitive arguments are parameterized as ?
CQLBuilder.fn('minTimeuuid', '2024-01-01')  // → minTimeuuid(?), params: ['2024-01-01']

// Unknown functions are rejected
CQLBuilder.fn('DROP');  // → CQLBuildError: Unknown CQL function "DROP"
```

Allowed functions include: `now`, `uuid`, `toTimestamp`, `toDate`, `toUnixTimestamp`, `currentTimestamp`, `currentDate`, `currentTime`, `currentTimeUUID`, `minTimeuuid`, `maxTimeuuid`, `token`, blob conversions, and aggregates (`count`, `min`, `max`, `sum`, `avg`).

## What Gets Validated

| Check | When |
|---|---|
| Table exists in schema | All operations |
| Column exists in schema | SELECT, INSERT, UPDATE SET, DELETE, WHERE |
| Primary key columns present | INSERT (all PK), UPDATE WHERE (all PK) |
| Cannot SET primary key column | UPDATE |
| ORDER BY only on clustering columns | SELECT |
| Collection ops match column type | UPDATE (addToSet on set<>, appendToList on list<>, putToMap on map<>) |
| Counter ops only on counter columns | UPDATE increment/decrement |
| UDT field exists and column is non-frozen | UPDATE setField |
| Server-side function is whitelisted | INSERT/UPDATE values using CQLBuilder.fn() |
| TTL/WRITETIME only on regular single-cell columns | SELECT ttl()/writetime() |
| Element deletion only on non-frozen map/list columns | DELETE element() |
| Version-gated features against the target release | SELECT ttl()/writetime() on collections (5.0+) |

## Version-Aware Validation

Some CQL is only valid on certain Cassandra releases — e.g. `SELECT TTL(a_collection)` is rejected by 4.x but returns a per-cell list on 5.0+. The builder validates offline, so it can't know your cluster's version unless you tell it. Three ways, in precedence order:

```javascript
// 1. Explicit option on the builder
const cql = new CQLBuilder(registry, { cassandraVersion: '5.0' });
cql.select('ks', 'table').ttl('tags');  // allowed — per-cell TTL list on 5.0+

// 2. Declared in the schema file itself (per keyspace)
// { "keyspace": "my_app", "cassandra_version": "5.0", ... }

// 3. Auto-detected from a live cluster
const introspector = new LiveSchemaIntrospector(client);
const version = await introspector.releaseVersion();   // e.g. "5.0.2"
const liveAware = new CQLBuilder(registry, { cassandraVersion: version });
```

With no version configured anywhere, the builder stays **conservative**: version-gated features are treated as unavailable (the pre-existing behavior — nothing breaks). An invalid version string throws at construction.

## DDL Generation

```javascript
const { DDLGenerator } = require('cassandra-guard');

const gen = new DDLGenerator(registry);
const statements = gen.generateKeyspace('ecommerce');
// → ['CREATE KEYSPACE ...', 'CREATE TYPE ...', 'CREATE TABLE ...', 'CREATE INDEX ...']
```

## Migration Diffing

Compare two schema versions and get migration CQL:

```javascript
const { MigrationDiffer } = require('cassandra-guard');

const differ = new MigrationDiffer();
const result = differ.diff(oldSchema, newSchema);

console.log(result.statements);  // ALTER TABLE ..., CREATE INDEX ..., etc.
console.log(result.warnings);    // Things that need attention
console.log(result.breaking);    // Destructive changes
```

Detects: new/dropped tables, added/dropped columns, type changes, index changes, replication changes, UDT changes, table option changes, primary key changes (as warnings).

## Live Cluster Diffing

Compare your JSON schema against a running cluster:

```javascript
const cassandra = require('cassandra-driver');
const { LiveSchemaIntrospector, MigrationDiffer } = require('cassandra-guard');

const client = new cassandra.Client({ contactPoints: ['localhost'], localDataCenter: 'dc1' });
await client.connect();

const introspector = new LiveSchemaIntrospector(client);
const liveSchema = await introspector.introspect('ecommerce');

const differ = new MigrationDiffer();
const result = differ.diff(liveSchema, targetSchema);
```

## Live Schema Compatibility Validation

Validate if a live production database can fully support your application's expected schema without breaking:

```javascript
const { LiveSchemaIntrospector, CompatibilityChecker } = require('cassandra-guard');

const introspector = new LiveSchemaIntrospector(client);
const liveSchema = await introspector.introspect('ecommerce');

const checker = new CompatibilityChecker();
const errors = checker.check(liveSchema, targetSchema);

if (errors.length > 0) {
  console.error('Database is incompatible:', errors);
} else {
  console.log('Database supports this application!');
}
```
*Note: The compatibility checker enforces a strict structural subset check. It ignores extra tables, columns, or UDTs in the live database, ensuring forward-compatibility with future schemas.*

## Raw CQL Validation

Validate hand-written CQL against the schema:

```javascript
const result = cql.validateRawCQL('SELECT user_id, fake_col FROM ecommerce.users');
// → { valid: false, errors: ['Column "fake_col" not found in ecommerce.users'] }

// Function projections are understood: the wrapped column is validated,
// aliases are ignored, and commas inside argument lists don't confuse it
cql.validateRawCQL('SELECT order_id, TTL(created_at) AS expires_at FROM ecommerce.orders_by_user');
// → { valid: true, errors: [] }
```

## CLI

```bash
# Validate schema files
npx csg validate schemas/

# Show schema info
npx csg info schemas/ecommerce.json
npx csg info schemas/ecommerce.json --table users

# Generate DDL
npx csg generate schemas/ecommerce.json
npx csg generate schemas/ecommerce.json -o ddl.cql

# Diff two schema versions
npx csg diff schemas/v1.json schemas/v2.json
npx csg diff schemas/v1.json schemas/v2.json --strict  # exit 1 on breaking changes

# Diff against live cluster
npx csg diff-live schemas/ecommerce.json --host 10.0.0.1 --datacenter dc1

# Check compatibility with live cluster
npx csg check-live schemas/ecommerce.json --host 10.0.0.1 --datacenter dc1

# Validate raw CQL
npx csg check-cql schemas/ecommerce.json "SELECT email FROM ecommerce.users"
```

## CI/CD Integration

Add to your pipeline:

```yaml
# Validate schemas are well-formed
- run: npx csg validate schemas/

# Check for breaking changes
- run: npx csg diff schemas/current.json schemas/new.json --strict

# Generate migration and review
- run: npx csg diff schemas/current.json schemas/new.json -o migration.cql

# Ensure production database can support this schema before deploying app
- run: npx csg check-live schemas/new.json --host prod-db.internal --user ci_user --pass my_secret
```

## License

MIT
